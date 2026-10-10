import crypto from "node:crypto";
import type { Db } from "../db.js";
import { getServerKv, setServerKv } from "../db.js";
import { logger } from "../logger.js";

/**
 * Binary image cache for album art, track thumbnails and channel avatars.
 *
 * Previously every browser asked YouTube for every picture, so a 50-track
 * grid meant 50 origin fetches per device per session. This keeps one copy on
 * the server instead: `GET /api/artwork?url=…` serves from here, and the
 * browser caches it again on top of that.
 *
 * Design points that matter for the "save resources" goal:
 *
 *  - **BLOBs, not base64.** The JSON cache stores text; a 40 KB thumbnail
 *    would cost 54 KB on disk plus a decode pass. `sqlite3_column_blob`
 *    hands back a `Uint8Array` we can write to the socket as-is.
 *  - **SHA-256 of the URL as the key.** Google's artwork URLs carry long
 *    query strings and size suffixes; a fixed 64-hex primary key keeps the
 *    index compact and makes lookups a single B-tree probe.
 *  - **Global, not per-user.** Artwork is public content and the same
 *    thumbnail is shared by every account that browses it, so a per-user
 *    namespace would multiply disk use by the number of accounts.
 *  - **Throttled bookkeeping.** `last_used` / `hit_count` are only rewritten
 *    once per `TOUCH_INTERVAL_MS`, so a scroll past 50 thumbnails is one
 *    write per image per interval instead of one write per render.
 *  - **Play-aware eviction.** When the budget is hit we throw away the art
 *    nobody looks at first: least played, then least requested, then least
 *    recently seen. The play signal comes from `play_history`, normalized
 *    through `artworkIdentity` so a play recorded against one thumbnail size
 *    still counts against the other sizes of the same picture.
 */

export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const MIN_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024 * 1024;
/** A single picture above this is served but never stored. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Trim to this fraction of the budget so the next inserts don't each re-evict. */
const EVICTION_HEADROOM = 0.9;
/** How long `last_used` / `hit_count` may lag before being rewritten. */
const TOUCH_INTERVAL_MS = 30_000;
/** Deletes are chunked to stay well under SQLite's bound-parameter ceiling. */
const DELETE_CHUNK = 500;

/** server_kv key holding the budget; exported so tests can set it directly. */
export const IMAGE_CACHE_MAX_BYTES_KEY = "imageCache.maxBytes";

export interface ImageCacheStats {
  maxBytes: number;
  usedBytes: number;
  entryCount: number;
  /** Fraction of the budget in use, 0..1 — what the settings meter shows. */
  usageRatio: number;
}

export interface CachedImage {
  hash: string;
  data: Uint8Array;
  contentType: string;
  bytes: number;
  hitCount: number;
}

export interface CachedImageEntry {
  hash: string;
  url: string;
  contentType: string;
  bytes: number;
  createdAt: number;
  lastUsed: number;
  hitCount: number;
  /** How many times any account played the track this picture belongs to. */
  playCount: number;
}

export interface StoreResult {
  stored: boolean;
  reason?: "too_large" | "exceeds_budget";
}

const YTIMG_VIDEO_RE = /https:\/\/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//;
// Google's channel art is served from a long opaque path with a size suffix
// (`…/AAAA=w544-h544-l90-rj`) or a query string; everything before the first
// `=`/`?` is the stable identity of that avatar.
const CHANNEL_ART_RE = /^https:\/\/[^/]*(?:googleusercontent\.com|ggpht\.com)\/([^=?]+)/;

/**
 * Collapses an artwork URL to the identity shared by its size variants, so
 * "the same picture" matches across `hqdefault.jpg`, `w540-h540.jpg` and the
 * `=w120-h120` avatar suffixes. Unrecognized shapes fall through unchanged,
 * which degrades the ranking to recency rather than losing the play.
 */
export function artworkIdentity(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const video = YTIMG_VIDEO_RE.exec(trimmed);
  if (video?.[1]) return `video:${video[1]}`;
  const channel = CHANNEL_ART_RE.exec(trimmed);
  if (channel?.[1]) return `channel:${channel[1]}`;
  return `url:${trimmed}`;
}

export function hashImageUrl(url: string): string {
  return crypto.createHash("sha256").update(url, "utf8").digest("hex");
}

export function getImageCacheMaxBytes(db: Db): number {
  const raw = getServerKv(db, IMAGE_CACHE_MAX_BYTES_KEY);
  if (!raw) return DEFAULT_IMAGE_CACHE_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_CACHE_MAX_BYTES;
}

export function setImageCacheMaxBytes(db: Db, maxBytes: number): ImageCacheStats {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("Artwork cache size must be a positive number of bytes.");
  }
  const clamped = Math.min(Math.max(Math.floor(maxBytes), MIN_IMAGE_CACHE_MAX_BYTES), MAX_IMAGE_CACHE_MAX_BYTES);
  setServerKv(db, IMAGE_CACHE_MAX_BYTES_KEY, String(clamped));
  enforceImageCacheLimit(db);
  return getImageCacheStats(db);
}

export function getImageCacheStats(db: Db): ImageCacheStats {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS usedBytes, COUNT(*) AS entryCount FROM image_cache",
    )
    .get() as { usedBytes: number; entryCount: number };
  const usedBytes = Number(row.usedBytes ?? 0);
  const maxBytes = getImageCacheMaxBytes(db);
  return {
    maxBytes,
    usedBytes,
    entryCount: Number(row.entryCount ?? 0),
    usageRatio: maxBytes > 0 ? Math.min(1, usedBytes / maxBytes) : 0,
  };
}

interface TouchRow {
  last_used: number;
  hit_count: number;
}

/**
 * Reads a stored picture, or `null` on a miss. The recency bookkeeping is
 * deliberately throttled: an `<img>` render must not become a write
 * transaction, so a hit inside `TOUCH_INTERVAL_MS` is served without touching
 * the database at all.
 */
export function readCachedImage(db: Db, url: string): CachedImage | null {
  const hash = hashImageUrl(url);
  const row = db
    .prepare(
      "SELECT hash, data, content_type, bytes, hit_count, last_used FROM image_cache WHERE hash = ?",
    )
    .get(hash) as
    | { hash: string; data: Uint8Array; content_type: string; bytes: number } & TouchRow
    | undefined;
  if (!row) return null;

  const now = Date.now();
  if (now - row.last_used >= TOUCH_INTERVAL_MS) {
    db.prepare(
      "UPDATE image_cache SET last_used = ?, hit_count = hit_count + 1 WHERE hash = ?",
    ).run(now, hash);
  }

  return {
    hash: row.hash,
    data: row.data,
    contentType: row.content_type,
    bytes: row.bytes,
    hitCount: row.hit_count,
  };
}

/** Cheap existence probe for `If-None-Match` — never loads the blob. */
export function hasCachedImage(db: Db, url: string): boolean {
  const hash = hashImageUrl(url);
  return Boolean(db.prepare("SELECT 1 AS ok FROM image_cache WHERE hash = ?").get(hash));
}

export function touchCachedImage(db: Db, url: string): void {
  db.prepare(
    "UPDATE image_cache SET last_used = ?, hit_count = hit_count + 1 WHERE hash = ?",
  ).run(Date.now(), hashImageUrl(url));
}

export function storeCachedImage(
  db: Db,
  url: string,
  contentType: string,
  data: Uint8Array,
): StoreResult {
  const bytes = data.byteLength;
  const maxBytes = getImageCacheMaxBytes(db);
  // An oversized picture is served by the caller but not retained: storing it
  // would mean evicting everything else for one asset.
  if (bytes > MAX_IMAGE_BYTES) return { stored: false, reason: "too_large" };
  if (bytes > maxBytes) return { stored: false, reason: "exceeds_budget" };

  const now = Date.now();
  db.prepare(
    `INSERT INTO image_cache (hash, url, content_type, data, bytes, created_at, last_used, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(hash) DO UPDATE SET
       content_type = excluded.content_type,
       data = excluded.data,
       bytes = excluded.bytes,
       last_used = excluded.last_used`,
  ).run(hashImageUrl(url), url, contentType, data, bytes, now, now);

  enforceImageCacheLimit(db);
  return { stored: true };
}

interface EvictionCandidate {
  hash: string;
  bytes: number;
  url: string;
  hit_count: number;
  last_used: number;
}

interface PlayAggregate {
  artwork_url: string;
  plays: number;
}

/**
 * Play counts per artwork identity. Grouped in SQL (one pass over
 * `play_history`) and folded in JS through `artworkIdentity`, which keeps the
 * normalization in a single testable place instead of mirroring it in SQL
 * string functions.
 */
function playCountsByArtwork(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT artwork_url AS artwork_url, COUNT(*) AS plays FROM play_history WHERE artwork_url IS NOT NULL AND artwork_url <> '' GROUP BY artwork_url",
    )
    .all() as unknown as PlayAggregate[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = artworkIdentity(row.artwork_url);
    counts.set(key, (counts.get(key) ?? 0) + Number(row.plays ?? 0));
  }
  return counts;
}

/**
 * Brings the cache back under budget. Runs only when the limit is crossed,
 * and trims to `EVICTION_HEADROOM` of it rather than exactly to the line, so
 * the next few thousand thumbnails don't each pay for another full sweep.
 */
export function enforceImageCacheLimit(db: Db): { evicted: number; freedBytes: number } {
  const maxBytes = getImageCacheMaxBytes(db);
  const stats = getImageCacheStats(db);
  if (stats.usedBytes <= maxBytes) return { evicted: 0, freedBytes: 0 };

  const target = Math.floor(maxBytes * EVICTION_HEADROOM);
  const plays = playCountsByArtwork(db);
  const candidates = db
    .prepare(
      "SELECT hash, bytes, url, hit_count, last_used FROM image_cache ORDER BY last_used ASC",
    )
    .all() as unknown as EvictionCandidate[];

  candidates.sort((left, right) => {
    const leftPlays = plays.get(artworkIdentity(left.url)) ?? 0;
    const rightPlays = plays.get(artworkIdentity(right.url)) ?? 0;
    if (leftPlays !== rightPlays) return leftPlays - rightPlays;
    if (left.hit_count !== right.hit_count) return left.hit_count - right.hit_count;
    return left.last_used - right.last_used;
  });

  const doomed: string[] = [];
  let remaining = stats.usedBytes;
  for (const candidate of candidates) {
    if (remaining <= target) break;
    doomed.push(candidate.hash);
    remaining -= candidate.bytes;
  }
  deleteByHashes(db, doomed);

  if (doomed.length > 0) {
    logger.info("imageCache.evicted", {
      evicted: doomed.length,
      freedBytes: stats.usedBytes - remaining,
      maxBytes,
      headroom: EVICTION_HEADROOM,
    });
  }
  return { evicted: doomed.length, freedBytes: stats.usedBytes - remaining };
}

function deleteByHashes(db: Db, hashes: string[]): number {
  let deleted = 0;
  for (let index = 0; index < hashes.length; index += DELETE_CHUNK) {
    const chunk = hashes.slice(index, index + DELETE_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    deleted += Number(
      db.prepare(`DELETE FROM image_cache WHERE hash IN (${placeholders})`).run(...chunk).changes,
    );
  }
  return deleted;
}

/**
 * "Format" — the admin's manual reset. VACUUM afterwards so the freed pages
 * actually go back to the filesystem instead of lingering on SQLite's free
 * list; without it a full clear leaves the file at its high-water mark.
 */
export function clearImageCache(db: Db): ImageCacheStats {
  const before = getImageCacheStats(db);
  db.prepare("DELETE FROM image_cache").run();
  try {
    db.exec("VACUUM");
  } catch (error) {
    logger.warn("imageCache.vacuum failed", { error });
  }
  logger.info("imageCache.formatted", { entries: before.entryCount, bytes: before.usedBytes });
  return getImageCacheStats(db);
}

/** Admin panel: biggest occupants, ranked so the eviction story is legible. */
export function listCachedImages(db: Db, limit: number): CachedImageEntry[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = db
    .prepare(
      `SELECT hash, url, content_type, bytes, created_at, last_used, hit_count
         FROM image_cache ORDER BY bytes DESC LIMIT ?`,
    )
    .all(capped) as unknown as Array<{
    hash: string;
    url: string;
    content_type: string;
    bytes: number;
    created_at: number;
    last_used: number;
    hit_count: number;
  }>;
  if (rows.length === 0) return [];

  const plays = playCountsByArtwork(db);
  return rows.map((row) => ({
    hash: row.hash,
    url: row.url,
    contentType: row.content_type,
    bytes: Number(row.bytes),
    createdAt: row.created_at,
    lastUsed: row.last_used,
    hitCount: Number(row.hit_count),
    playCount: plays.get(artworkIdentity(row.url)) ?? 0,
  }));
}

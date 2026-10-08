import { logger } from "../logger.js";
import type { Db } from "../db.js";
import { getServerKv, setServerKv } from "../db.js";

/**
 * Server-side JSON cache mirroring the original app's Rust disk LRU cache
 * (`cache_get` / `cache_set` / `cache_stats` / `cache_set_max_bytes` /
 * `cache_clear`). Entries are stored in SQLite, keyed by namespace (user id or
 * "anon") + key, evicted least-recently-used-first when over the byte budget.
 */

export const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024;

export interface CacheStats {
  maxBytes: number;
  usedBytes: number;
  entryCount: number;
}

const MAX_CACHE_BYTES_KEY = "cache.maxBytes";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getCacheMaxBytes(db: Db): number {
  const raw = getServerKv(db, MAX_CACHE_BYTES_KEY);
  if (!raw) return DEFAULT_CACHE_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_MAX_BYTES;
}

export function setCacheMaxBytes(db: Db, maxBytes: number): CacheStats {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("Cache size must be a positive number of bytes.");
  }
  setServerKv(db, MAX_CACHE_BYTES_KEY, String(Math.floor(maxBytes)));
  enforceCacheLimit(db);
  return getCacheStats(db);
}

export function cacheGet(db: Db, namespace: string, key: string): string | null {
  const row = db.prepare(
    "SELECT value FROM cache_entries WHERE namespace = ? AND key = ?",
  ).get(namespace, key) as { value: string } | undefined;
  if (row) {
    db.prepare(
      "UPDATE cache_entries SET last_used = ? WHERE namespace = ? AND key = ?",
    ).run(Date.now(), namespace, key);
  }
  return row?.value ?? null;
}

export function cacheSet(db: Db, namespace: string, key: string, value: string): { changed: boolean } {
  const bytes = byteLength(value);
  const maxBytes = getCacheMaxBytes(db);
  if (bytes > maxBytes) {
    // An entry larger than the whole budget is not storable; treat as unchanged
    // rather than evicting everything for one oversized value.
    logger.warn("cache.set entry exceeds budget", { bytes, maxBytes });
    return { changed: false };
  }

  const existing = db.prepare(
    "SELECT value FROM cache_entries WHERE namespace = ? AND key = ?",
  ).get(namespace, key) as { value: string } | undefined;
  const changed = existing?.value !== value;

  db.prepare(
    `INSERT INTO cache_entries (namespace, key, value, bytes, last_used)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET
       value = excluded.value,
       bytes = excluded.bytes,
       last_used = excluded.last_used`,
  ).run(namespace, key, value, bytes, Date.now());

  if (changed) enforceCacheLimit(db);
  return { changed };
}

function enforceCacheLimit(db: Db): void {
  const maxBytes = getCacheMaxBytes(db);
  const stats = getCacheStats(db);
  if (stats.usedBytes <= maxBytes) return;

  let { usedBytes } = stats;
  const candidates = db
    .prepare(
      "SELECT namespace, key, bytes FROM cache_entries ORDER BY last_used ASC",
    )
    .all() as Array<{ namespace: string; key: string; bytes: number }>;
  for (const entry of candidates) {
    if (usedBytes <= maxBytes) break;
    db.prepare("DELETE FROM cache_entries WHERE namespace = ? AND key = ?").run(
      entry.namespace,
      entry.key,
    );
    usedBytes -= entry.bytes;
  }
}

export function getCacheStats(db: Db): CacheStats {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS usedBytes, COUNT(*) AS entryCount FROM cache_entries",
    )
    .get() as { usedBytes: number; entryCount: number };
  return {
    maxBytes: getCacheMaxBytes(db),
    usedBytes: Number(row.usedBytes ?? 0),
    entryCount: Number(row.entryCount ?? 0),
  };
}

export function clearCache(db: Db, namespace?: string): CacheStats {
  if (namespace) {
    db.prepare("DELETE FROM cache_entries WHERE namespace = ?").run(namespace);
  } else {
    db.prepare("DELETE FROM cache_entries").run();
  }
  return getCacheStats(db);
}

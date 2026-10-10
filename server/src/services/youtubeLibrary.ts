import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { getValidAccessToken } from "./youtubeAccount.js";
import { logger } from "../logger.js";

/**
 * YouTube Music **library** reads for a linked OAuth account.
 *
 * Why this exists: an OAuth device-code token only works against InnerTube's
 * TVHTML5 client (client name 7). The WEB_REMIX client (67) that the browser
 * uses rejects every OAuth-authenticated request with
 * `400 Request contains an invalid argument` — verified against live YouTube:
 * the same token succeeds on TVHTML5 (`VLLM` → the account's real Liked
 * Songs) and fails identically on WEB_REMIX regardless of `X-Goog-AuthUser`,
 * `Origin`, or `Referer`. Cookies are what WEB_REMIX wants, and this server
 * has no cookies — it has a refresh token. So account-scoped library reads
 * are proxied through TVHTML5 here, server-side.
 *
 * TVHTML5 answers with its own renderer family (`tvBrowseRenderer`,
 * `tileRenderer`, …), unrelated to the `music*Renderer` shapes the web client
 * parses, so the payload is normalised into plain objects before it leaves
 * this module.
 */

const TV_CLIENT_NAME = "7";
const TV_CLIENT_VERSION = "7.20250422.18.00";
const TV_BROWSE = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false";
const REQUEST_TIMEOUT_MS = 25_000;
/** Cap continuation pages per surface so one account cannot stall a request. */
const MAX_PAGES = 8;

export interface YouTubeLibraryTrack {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec?: number;
}

export interface YouTubeLibraryPlaylist {
  id: string;
  title: string;
  owner: string;
  artworkUrl?: string;
  trackCount?: number;
}

export interface YouTubeLibraryAlbum {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string;
}

export interface YouTubeLibraryResult {
  account: { name: string | null };
  playlists: YouTubeLibraryPlaylist[];
  likedSongs: YouTubeLibraryTrack[];
  albums: YouTubeLibraryAlbum[];
  recentlyPlayed: YouTubeLibraryTrack[];
}

/* ------------------------------------------------------------------ */
/* Typed accessors over the untyped TVHTML5 JSON                        */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walks a JSON tree collecting every node stored under `key`. */
function collect(node: unknown, key: string, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 30 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out, depth + 1);
    return out;
  }
  for (const [k, value] of Object.entries(node as Json)) {
    if (k === key) out.push(value);
    collect(value, key, out, depth + 1);
  }
  return out;
}

/** First `simpleText` / concatenated `runs` under a text-ish node. */
function readText(node: unknown): string | null {
  if (!isObject(node)) return null;
  const simple = node.simpleText;
  if (typeof simple === "string" && simple.trim()) return simple.trim();
  const runs = node.runs;
  if (Array.isArray(runs)) {
    const text = runs
      .map((run) => (isObject(run) && typeof run.text === "string" ? run.text : ""))
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

function readThumbnails(node: unknown): string | undefined {
  const thumbs = collect(node, "thumbnails");
  for (const entry of thumbs) {
    if (!Array.isArray(entry)) continue;
    const last = entry[entry.length - 1];
    if (isObject(last) && typeof last.url === "string") return last.url;
  }
  return undefined;
}

/** "3:33" / "1,024 views" → seconds, when the value looks like a clock. */
function parseDuration(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(seconds)) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

/** "Playlist • 3 views • 4 tracks" → 4 */
function parseCount(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = /(\d[\d,]*)\s+(?:tracks?|songs?|videos?)/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function tvBrowse(
  token: string,
  args: { browseId?: string; continuation?: string },
): Promise<Json | null> {
  const body = JSON.stringify({
    context: { client: { clientName: TV_CLIENT_NAME, clientVersion: TV_CLIENT_VERSION, hl: "en", gl: "US" } },
    ...(args.browseId ? { browseId: args.browseId } : {}),
    ...(args.continuation ? { continuation: args.continuation } : {}),
  });

  try {
    const response = await fetch(TV_BROWSE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": TV_CLIENT_NAME,
        "x-youtube-client-version": TV_CLIENT_VERSION,
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("youtube.library tv browse failed", {
        browseId: args.browseId,
        status: response.status,
      });
      return null;
    }
    const payload = (await response.json()) as unknown;
    return isObject(payload) ? payload : null;
  } catch (error) {
    logger.warn("youtube.library tv browse threw", {
      browseId: args.browseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Follows `continuationCommand` tokens until the surface is exhausted. */
async function tvBrowseAll(token: string, browseId: string): Promise<Json[]> {
  const pages: Json[] = [];
  const first = await tvBrowse(token, { browseId });
  if (!first) return pages;
  pages.push(first);

  let continuation = readContinuation(first);
  while (continuation && pages.length < MAX_PAGES) {
    const next = await tvBrowse(token, { continuation });
    if (!next) break;
    pages.push(next);
    continuation = readContinuation(next);
  }
  return pages;
}

function readContinuation(page: Json): string | null {
  const commands = collect(page, "continuationCommand");
  for (const command of commands) {
    if (isObject(command) && typeof command.token === "string") return command.token;
  }
  const reloaded = collect(page, "reloadContinuationData");
  for (const command of reloaded) {
    if (isObject(command) && typeof command.continuation === "string") return command.continuation;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** Every `tileRenderer` on a page — the TVHTML5 unit for both tracks and playlists. */
function tiles(page: Json): Json[] {
  return collect(page, "tileRenderer").filter(isObject);
}

function tileTitle(tile: Json): string | null {
  const metadata = collect(tile, "tileMetadataRenderer")[0];
  if (!isObject(metadata)) return null;
  return readText(collect(metadata, "title")[0]);
}

function tileLines(tile: Json): string[] {
  const metadata = collect(tile, "tileMetadataRenderer")[0];
  if (!isObject(metadata)) return [];
  const items = collect(metadata, "lineItemRenderer");
  const out: string[] = [];
  for (const item of items) {
    // `lineItemRenderer` wraps its label in a `text` node.
    const text = isObject(item) ? readText(item.text) : null;
    if (text) out.push(text);
  }
  return out;
}

function tileDuration(tile: Json): number | undefined {
  const overlays = collect(tile, "thumbnailOverlayTimeStatusRenderer");
  for (const overlay of overlays) {
    const parsed = parseDuration(readText(isObject(overlay) ? overlay.text : null));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tileVideoId(tile: Json): string | null {
  const endpoints = collect(tile, "watchEndpoint");
  for (const endpoint of endpoints) {
    if (isObject(endpoint) && typeof endpoint.videoId === "string") return endpoint.videoId;
  }
  return null;
}

function tileBrowseId(tile: Json, prefixes: string[]): string | null {
  const endpoints = collect(tile, "browseEndpoint");
  for (const endpoint of endpoints) {
    if (!isObject(endpoint)) continue;
    const browseId = endpoint.browseId;
    if (typeof browseId !== "string") continue;
    if (prefixes.length === 0 || prefixes.some((prefix) => browseId.startsWith(prefix))) {
      return browseId;
    }
  }
  return null;
}

/** Strips the `VL` prefix YouTube prepends to playlist browse ids. */
function stripVlPrefix(browseId: string): string {
  return browseId.startsWith("VL") ? browseId.slice(2) : browseId;
}

function toTrack(tile: Json): YouTubeLibraryTrack | null {
  const id = tileVideoId(tile);
  const title = tileTitle(tile);
  if (!id || !title) return null;
  const lines = tileLines(tile);
  return {
    id,
    title,
    artist: lines[0] ?? "",
    artworkUrl: readThumbnails(collect(tile, "tileHeaderRenderer")[0] ?? collect(tile, "thumbnail")[0]),
    durationSec: tileDuration(tile),
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function getYouTubeLibrary(
  db: Db,
  config: ServerConfig,
  userId: string,
): Promise<YouTubeLibraryResult | null> {
  const token = await getValidAccessToken(db, config, userId);
  if (!token) return null;

  const [playlistPage, likedPages, albumPage, recentPage] = await Promise.all([
    tvBrowse(token, { browseId: "FEmusic_liked_playlists" }),
    tvBrowseAll(token, "VLLM"),
    tvBrowse(token, { browseId: "FEmusic_liked_albums" }),
    tvBrowse(token, { browseId: "FEmusic_last_played" }),
  ]);

  // ---- playlists ----
  const playlists: YouTubeLibraryPlaylist[] = [];
  const seenPlaylists = new Set<string>();
  if (playlistPage) {
    for (const tile of tiles(playlistPage)) {
      const browseId = tileBrowseId(tile, ["VL"]);
      const title = tileTitle(tile);
      if (!browseId || !title) continue;
      const id = stripVlPrefix(browseId);
      if (seenPlaylists.has(id)) continue;
      seenPlaylists.add(id);
      const lines = tileLines(tile);
      playlists.push({
        id,
        title,
        // The auto "Liked Music" playlist has no owner line; it belongs to the caller.
        owner: lines[0] && !/^\d/.test(lines[0]) && !/^(Playlist|Auto playlist)/i.test(lines[0])
          ? lines[0]
          : "You",
        artworkUrl: readThumbnails(collect(tile, "tileHeaderRenderer")[0] ?? collect(tile, "thumbnail")[0]),
        trackCount: parseCount(lines.find((line) => /tracks?|songs?|videos?/i.test(line))),
      });
    }
  }

  // ---- liked songs ----
  const likedSongs: YouTubeLibraryTrack[] = [];
  const seenLiked = new Set<string>();
  for (const page of likedPages) {
    for (const tile of tiles(page)) {
      const track = toTrack(tile);
      if (!track || seenLiked.has(track.id)) continue;
      seenLiked.add(track.id);
      likedSongs.push(track);
    }
  }

  // ---- albums ----
  const albums: YouTubeLibraryAlbum[] = [];
  const seenAlbums = new Set<string>();
  if (albumPage) {
    for (const tile of tiles(albumPage)) {
      const browseId = tileBrowseId(tile, ["VL", "MPRE"]);
      const title = tileTitle(tile);
      if (!browseId || !title) continue;
      const id = stripVlPrefix(browseId);
      if (seenAlbums.has(id)) continue;
      seenAlbums.add(id);
      albums.push({
        id,
        title,
        artist: tileLines(tile)[0] ?? "",
        artworkUrl: readThumbnails(collect(tile, "tileHeaderRenderer")[0] ?? collect(tile, "thumbnail")[0]),
      });
    }
  }

  // ---- recently played ----
  const recentlyPlayed: YouTubeLibraryTrack[] = [];
  const seenRecent = new Set<string>();
  if (recentPage) {
    for (const tile of tiles(recentPage)) {
      const track = toTrack(tile);
      if (!track || seenRecent.has(track.id)) continue;
      seenRecent.add(track.id);
      recentlyPlayed.push(track);
    }
  }

  logger.info("youtube.library loaded", {
    userId,
    playlists: playlists.length,
    likedSongs: likedSongs.length,
    albums: albums.length,
    recentlyPlayed: recentlyPlayed.length,
  });

  return {
    // The account name comes from the OpenDeck session, not YouTube.
    account: { name: null },
    playlists,
    likedSongs,
    albums,
    recentlyPlayed,
  };
}

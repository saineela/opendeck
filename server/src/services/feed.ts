import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { forwardProxyRequest, type ProxyRequestInput } from "./proxy.js";

/**
 * Server-side feed API: home shelves ("Made for you", "Today's biggest
 * hits", …), the watch-next recommendation panel, and playlist detail with
 * its ordered songs — the three shapes the client needs to render a feed
 * without talking to InnerTube itself.
 *
 * All upstream traffic goes through `forwardProxyRequest`, so the host
 * allowlist, header stripping, redirect pinning, response-size caps, and
 * OAuth Bearer injection (when the account linked YouTube) apply unchanged.
 * The parsers below are pure functions over the InnerTube JSON, exported so
 * tests can exercise them without a network.
 *
 * Shapes were probed against live `music.youtube.com/youtubei/v1/browse`
 * and `/next` with the WEB_REMIX client (Oct 2026).
 */

/** Upstream/parse failure surfaced to the route with an HTTP status. */
export class FeedError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

export type FeedItemType = "song" | "video" | "playlist" | "album" | "artist" | "other";

export interface FeedItem {
  id: string;
  type: FeedItemType;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  videoId?: string;
  browseId?: string;
  params?: string;
  /** Watch-next items only: display string ("3:34") + parsed seconds. */
  durationText?: string;
  durationSeconds?: number | null;
}

export interface FeedSection {
  title: string;
  items: FeedItem[];
}

export interface FeedPlaylistTrack {
  videoId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationText: string | null;
  durationSeconds: number | null;
}

export interface FeedPlaylistDetail {
  browseId: string;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  description: string | null;
  tracks: FeedPlaylistTrack[];
}

/* ------------------------------------------------------------------ *
 * Small JSON helpers (InnerTube is deeply nested, never typed)
 * ------------------------------------------------------------------ */

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Joins `runs[].text` (or `simpleText`) into one string. */
function runsText(node: unknown): string | null {
  const obj = asObj(node);
  if (!obj) return null;
  if (typeof obj.simpleText === "string" && obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) {
    const text = obj.runs
      .map((run) => (asObj(run)?.text as string | undefined) ?? "")
      .join("");
    return text || null;
  }
  return null;
}

/** Largest thumbnail URL under `…thumbnails[]`, unwrapping renderer keys. */
function pickThumbnails(node: unknown): string | null {
  const obj = asObj(node);
  if (!obj) return null;
  if (Array.isArray(obj.thumbnails)) {
    let best: { url: string; width: number } | null = null;
    for (const entry of obj.thumbnails) {
      const item = asObj(entry);
      if (!item) continue;
      const url = typeof item.url === "string" ? item.url : null;
      if (!url) continue;
      const width = typeof item.width === "number" ? item.width : 0;
      if (!best || width > best.width) best = { url, width };
    }
    return best?.url ?? null;
  }
  for (const key of ["thumbnail", "thumbnailRenderer", "musicThumbnailRenderer"]) {
    if (obj[key]) {
      const hit = pickThumbnails(obj[key]);
      if (hit) return hit;
    }
  }
  return null;
}

/** First element of a `runs` array, when present. */
function firstRun(node: unknown): Record<string, unknown> | null {
  const obj = asObj(node);
  if (!obj || !Array.isArray(obj.runs)) return null;
  return asObj(obj.runs[0]);
}

/** Depth-first search for the first node stored under `key`. */
function findKey(node: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (depth > 16 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findKey(item, key, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const direct = asObj(obj[key]);
  if (direct) return direct;
  for (const value of Object.values(obj)) {
    const hit = findKey(value, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function durationToSeconds(text: string | null): number | null {
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part.trim())) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

const PAGE_TYPE_TO_ITEM: Record<string, FeedItemType> = {
  MUSIC_PAGE_TYPE_PLAYLIST: "playlist",
  MUSIC_PAGE_TYPE_ALBUM: "album",
  MUSIC_PAGE_TYPE_ARTIST: "artist",
  MUSIC_PAGE_TYPE_TRACK: "song",
  MUSIC_PAGE_TYPE_VIDEO: "video",
  MUSIC_PAGE_TYPE_PROFILE: "other",
};

function itemFromNavigation(nav: unknown): { id: string; type: FeedItemType; videoId?: string; browseId?: string; params?: string } | null {
  const obj = asObj(nav);
  if (!obj) return null;
  const watch = asObj(obj.watchEndpoint);
  if (watch && typeof watch.videoId === "string") {
    return { id: watch.videoId, type: "song", videoId: watch.videoId };
  }
  const browse = asObj(obj.browseEndpoint);
  if (browse && typeof browse.browseId === "string") {
    const configs = asObj(browse.browseEndpointContextSupportedConfigs);
    const musicConfig = asObj(configs?.browseEndpointContextMusicConfig);
    const pageType = typeof musicConfig?.pageType === "string" ? musicConfig.pageType : "";
    return {
      id: browse.browseId,
      type: PAGE_TYPE_TO_ITEM[pageType] ?? "other",
      browseId: browse.browseId,
      params: typeof browse.params === "string" ? browse.params : undefined,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Parsers (pure)
 * ------------------------------------------------------------------ */

/**
 * Home feed: `singleColumnBrowseResultsRenderer → sectionListRenderer →
 * musicCarouselShelfRenderer` shelves. The tastebuilder shelf and any other
 * non-carousel section are skipped.
 */
export function parseHomeSections(raw: unknown): FeedSection[] {
  const sectionList =
    findKey(asObj(raw)?.contents, "sectionListRenderer") ??
    findKey(raw, "sectionListRenderer");
  if (!sectionList || !Array.isArray(sectionList.contents)) return [];

  const sections: FeedSection[] = [];
  for (const entry of sectionList.contents) {
    const shelf = asObj(asObj(entry)?.musicCarouselShelfRenderer);
    if (!shelf) continue; // e.g. musicTastebuilderShelfRenderer

    const header = asObj(shelf.header);
    const basicHeader = asObj(header?.musicCarouselShelfBasicHeaderRenderer);
    const title = runsText(basicHeader?.title) ?? "";
    if (!Array.isArray(shelf.contents)) continue;

    const items: FeedItem[] = [];
    for (const node of shelf.contents) {
      const renderer = asObj(asObj(node)?.musicTwoRowItemRenderer);
      if (!renderer) continue;
      const titleText = runsText(renderer.title);
      if (!titleText) continue;

      const nav =
        itemFromNavigation(renderer.navigationEndpoint) ??
        itemFromNavigation(firstRun(renderer.title)?.navigationEndpoint);
      if (!nav) continue;

      items.push({
        id: nav.id,
        type: nav.type,
        title: titleText,
        subtitle: runsText(renderer.subtitle),
        artworkUrl: pickThumbnails(renderer.thumbnailRenderer),
        ...(nav.videoId ? { videoId: nav.videoId } : {}),
        ...(nav.browseId ? { browseId: nav.browseId } : {}),
        ...(nav.params ? { params: nav.params } : {}),
      });
    }
    if (items.length > 0) sections.push({ title, items });
  }
  return sections;
}

/**
 * When the initial `/next` panel only holds the seed, YouTube answers with
 * an `automixPreviewVideoRenderer` pointing at the real queue
 * (`watchPlaylistEndpoint`). youtubei.js follows it the same way. Returns
 * the `{playlistId, params}` pair to re-request, or null when absent.
 */
export function parseAutomixEndpoint(raw: unknown): { playlistId: string; params?: string } | null {
  const panel = findKey(raw, "playlistPanelRenderer");
  if (!panel || !Array.isArray(panel.contents)) return null;
  for (const node of panel.contents) {
    const renderer = asObj(asObj(node)?.automixPreviewVideoRenderer);
    const video = asObj(renderer?.content);
    const endpoint = asObj(video?.automixPlaylistVideoRenderer)?.navigationEndpoint as
      | Record<string, unknown>
      | undefined;
    const watch = asObj(endpoint?.watchPlaylistEndpoint);
    if (watch && typeof watch.playlistId === "string") {
      return {
        playlistId: watch.playlistId,
        ...(typeof watch.params === "string" ? { params: watch.params } : {}),
      };
    }
  }
  return null;
}

/**
 * Watch-next panel: `singleColumnMusicWatchNextResultsRenderer → … →
 * playlistPanelRenderer.contents[].playlistPanelVideoRenderer`. The entry
 * for the seed video itself is dropped (the caller already has it).
 */
export function parseWatchNext(raw: unknown, seedVideoId?: string): FeedItem[] {
  const panel = findKey(raw, "playlistPanelRenderer");
  if (!panel || !Array.isArray(panel.contents)) return [];

  const items: FeedItem[] = [];
  for (const node of panel.contents) {
    const renderer = asObj(asObj(node)?.playlistPanelVideoRenderer);
    if (!renderer) continue; // continuation entries
    const videoId = typeof renderer.videoId === "string" ? renderer.videoId : null;
    const title = runsText(renderer.title);
    if (!videoId || !title) continue;
    if (seedVideoId && videoId === seedVideoId) continue;

    const subtitle =
      runsText(renderer.shortBylineText) ??
      runsText(firstRun(renderer.longBylineText) ?? renderer.longBylineText);
    const durationText = runsText(renderer.lengthText);

    items.push({
      id: videoId,
      type: "song",
      title,
      subtitle,
      artworkUrl: pickThumbnails(renderer.thumbnail),
      videoId,
      ...(durationText
        ? { durationText, durationSeconds: durationToSeconds(durationText) }
        : {}),
    });
  }
  return items;
}

/**
 * Playlist (or album) detail: header renderer + the ordered shelf rows.
 * Falls back to `musicShelfRenderer`/`musicDetailHeaderRenderer` so album
 * browse ids behave the same way.
 */
export function parsePlaylistDetail(raw: unknown, browseId: string): FeedPlaylistDetail {
  const header =
    findKey(raw, "musicResponsiveHeaderRenderer") ??
    findKey(raw, "musicDetailHeaderRenderer");
  if (!header) {
    throw new FeedError("No playlist found for that browse id.", 404);
  }

  const shelf =
    findKey(raw, "musicPlaylistShelfRenderer") ?? findKey(raw, "musicShelfRenderer");

  const descriptionNode = asObj(header.description);
  const description =
    runsText(asObj(descriptionNode?.musicDescriptionShelfRenderer)?.description) ??
    runsText(header.description);

  const tracks: FeedPlaylistTrack[] = [];
  if (shelf && Array.isArray(shelf.contents)) {
    for (const node of shelf.contents) {
      const row = asObj(asObj(node)?.musicResponsiveListItemRenderer);
      if (!row) continue;

      const flex = Array.isArray(row.flexColumns) ? row.flexColumns : [];
      const column = (index: number): Record<string, unknown> | null =>
        asObj(
          asObj(asObj(flex[index])?.musicResponsiveListItemFlexColumnRenderer)?.text,
        );

      const titleNode = column(0);
      const title = runsText(titleNode);
      if (!title) continue;

      const nav = itemFromNavigation(firstRun(titleNode)?.navigationEndpoint);
      const videoId =
        nav?.videoId ??
        (typeof asObj(row.playlistItemData)?.videoId === "string"
          ? (asObj(row.playlistItemData)?.videoId as string)
          : null);

      const fixed = Array.isArray(row.fixedColumns) ? row.fixedColumns : [];
      const durationText = runsText(
        asObj(asObj(asObj(fixed[0])?.musicResponsiveListItemFixedColumnRenderer)?.text),
      );

      tracks.push({
        videoId,
        title,
        artist: runsText(column(1)),
        album: runsText(column(2)),
        artworkUrl: pickThumbnails(row.thumbnail),
        durationText,
        durationSeconds: durationToSeconds(durationText),
      });
    }
  }

  return {
    browseId,
    title: runsText(header.title) ?? "",
    subtitle: runsText(header.subtitle),
    artworkUrl: pickThumbnails(header.thumbnail),
    description,
    tracks,
  };
}

/* ------------------------------------------------------------------ *
 * Upstream calls
 * ------------------------------------------------------------------ */

const INNERTUBE = "https://music.youtube.com/youtubei/v1";
const CLIENT = { clientName: "WEB_REMIX", clientVersion: "1.20241009.01.00" };

interface FeedContext {
  hl: string;
  gl: string;
}

async function innertube(
  db: Db,
  config: ServerConfig,
  userId: string | null,
  endpoint: "browse" | "next",
  payload: Record<string, unknown>,
  context: FeedContext,
): Promise<unknown> {
  const body = JSON.stringify({
    ...payload,
    context: { client: { clientName: CLIENT.clientName, clientVersion: CLIENT.clientVersion, ...context } },
  });
  const input: ProxyRequestInput = {
    url: `${INNERTUBE}/${endpoint}?prettyPrint=false`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-youtube-client-name": "67", // WEB_REMIX
      "x-youtube-client-version": CLIENT.clientVersion,
    },
    body_base64: Buffer.from(body, "utf8").toString("base64"),
    timeout_ms: 20_000,
  };

  const result = await forwardProxyRequest(db, config, input, userId);
  if (!result.ok) {
    throw new FeedError("YouTube Music is unavailable right now.", 502);
  }
  if (result.output.status !== 200) {
    throw new FeedError("YouTube Music is unavailable right now.", 502);
  }
  try {
    const text = Buffer.from(result.output.body_base64, "base64").toString("utf8");
    return JSON.parse(text);
  } catch {
    throw new FeedError("YouTube Music returned an unexpected response.", 502);
  }
}

/** Normalized home shelves for the signed-in user. */
export async function fetchHomeFeed(
  db: Db,
  config: ServerConfig,
  userId: string | null,
  context: FeedContext,
): Promise<FeedSection[]> {
  const raw = await innertube(db, config, userId, "browse", { browseId: "FEmusic_home" }, context);
  const sections = parseHomeSections(raw);
  if (sections.length === 0 && !findKey(raw, "sectionListRenderer")) {
    throw new FeedError("YouTube Music returned an unexpected response.", 502);
  }
  return sections;
}

/** Watch-next recommendations seeded by a video; the seed is omitted. */
export async function fetchWatchNext(
  db: Db,
  config: ServerConfig,
  userId: string | null,
  videoId: string,
  context: FeedContext,
): Promise<FeedItem[]> {
  const raw = await innertube(db, config, userId, "next", { videoId }, context);
  if (!findKey(raw, "playlistPanelRenderer")) {
    throw new FeedError("YouTube Music returned an unexpected response.", 502);
  }

  let items = parseWatchNext(raw, videoId);
  if (items.length === 0) {
    // The initial panel held only the seed + an automix pointer; follow it
    // to the real 50-item queue.
    const automix = parseAutomixEndpoint(raw);
    if (automix) {
      const queue = await innertube(
        db,
        config,
        userId,
        "next",
        { videoId, playlistId: automix.playlistId, ...(automix.params ? { params: automix.params } : {}) },
        context,
      );
      items = parseWatchNext(queue, videoId);
    }
  }
  return items;
}

/** Playlist header (with thumbnail) + ordered songs. */
export async function fetchPlaylistDetail(
  db: Db,
  config: ServerConfig,
  userId: string | null,
  browseId: string,
  params: string | null,
  context: FeedContext,
): Promise<FeedPlaylistDetail> {
  const payload: Record<string, unknown> = { browseId };
  if (params) payload.params = params;
  const raw = await innertube(db, config, userId, "browse", payload, context);
  return parsePlaylistDetail(raw, browseId);
}

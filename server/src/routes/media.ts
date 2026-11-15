import express, { type Request, type Response, type Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { requireAuth } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { fetchAllowlisted } from "../services/safeFetch.js";
import { recordPlay } from "../services/playHistory.js";
import { resolveYouTubePlayback } from "../services/youtubePlayback.js";
import { logger } from "../logger.js";

/**
 * Streams resolved YouTube audio bytes server-side (CORS-free for the
 * browser), replacing the desktop app's `fetch_audio_source` /
 * `download_audio_source` Rust commands and local media server.
 *
 * Only googlevideo CDN `videoplayback` URLs are accepted.
 */

/**
 * Bytes asked of googlevideo when the player's range is open-ended.
 *
 * googlevideo refuses an open-ended (`bytes=0-`) or absent range on many
 * signed URLs with a bare 403 while serving the same URL for a bounded range
 * (measured on a live itag=140 URL: 8/8 403 open-ended, 8/8 206 bounded). An
 * `<audio>` element always opens with `bytes=0-`, so forwarding it verbatim
 * made the relay answer 502 and the element failed with
 * MEDIA_ERR_SRC_NOT_SUPPORTED before it could ask again. Asking for a bounded
 * chunk keeps the response streamable and lets the player follow up with its
 * own ranges.
 */
const UPSTREAM_CHUNK_BYTES = 1 << 20;

/** Bounds an open-ended or absent range; leaves bounded ranges untouched. */
export function boundUpstreamRange(raw: string | undefined): string {
  const lastByte = UPSTREAM_CHUNK_BYTES - 1;
  if (!raw) return `bytes=0-${lastByte}`;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) return raw;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  // Suffix ranges ("bytes=-500") are already bounded.
  if (startRaw === "") return raw;
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0) return raw;
  if (endRaw !== "") {
    const end = Number(endRaw);
    return Number.isSafeInteger(end) && end >= start ? raw : `bytes=${start}-${start + lastByte}`;
  }
  return `bytes=${start}-${start + lastByte}`;
}

const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "expires",
  "date",
  "etag",
] as const;

/**
 * Bytes googlevideo will serve for one resolved URL, keyed by its query.
 *
 * Some videos (label content, e.g. Panini `bG_NI-cCxDs`) are capped: the CDN
 * serves roughly the first megabyte of the file and answers 403 for anything
 * beyond it, on every fresh signature. The audio element treats that refusal
 * as a fatal network error and abandons the megabyte it already buffered — the
 * "plays a second then freezes" symptom. Declaring the served length as the
 * resource length instead lets the element play everything it can get and end
 * cleanly, and keeps the refusal out of the player's way.
 */
const servedLengths = new Map<string, number>();
const SERVED_LENGTH_CACHE_MAX = 256;
const TAIL_PROBE_TIMEOUT_MS = 4_000;

async function servedContentLength(url: URL, declared: number): Promise<number> {
  if (!Number.isSafeInteger(declared) || declared <= 0) return declared;
  const key = url.search;
  const cached = servedLengths.get(key);
  if (cached !== undefined) return Math.min(cached, declared);

  let total = declared;
  try {
    const tailStart = Math.max(0, declared - 64);
    const response = await fetch(url, {
      headers: { range: `bytes=${tailStart}-${declared - 1}` },
      signal: AbortSignal.timeout(TAIL_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    // Only an explicit refusal shortens the resource; a transport hiccup is
    // not proof that the rest of the file is missing.
    if (response.status === 403) total = Math.min(declared, UPSTREAM_CHUNK_BYTES);
  } catch {
    return declared;
  }

  if (servedLengths.size >= SERVED_LENGTH_CACHE_MAX) servedLengths.clear();
  servedLengths.set(key, total);
  logger.info("media.stream served length", { declared, served: total });
  return Math.min(total, declared);
}

function parseStreamUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!isGooglevideoHost(url.hostname)) return null;
    if (url.pathname !== "/videoplayback") return null;
    return url;
  } catch {
    return null;
  }
}

function isGooglevideoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "googlevideo.com" || host.endsWith(".googlevideo.com");
}

/** Redirect hops must stay on the googlevideo CDN (no SSRF via redirect). */
function isMediaHopAllowed(url: URL): boolean {
  return url.protocol === "https:" && isGooglevideoHost(url.hostname);
}

/**
 * Optional metadata query params (title, artist, album, artwork, durationSec,
 * videoId) let callers enrich play history; the CDN URL's `id` param is the
 * fallback video id. All values are sanitized by the history service.
 */
function stringParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value ? value.slice(0, 2048) : undefined;
}

function recordStreamPlay(req: Request, db: Db, url: URL): void {
  if (!req.sessionUserId) return;
  const videoId = stringParam(req, "videoId") ?? url.searchParams.get("id") ?? null;
  if (!videoId) return;
  const rawDuration = Number(req.query.durationSec);
  const title = stringParam(req, "title") ?? videoId;
  const artist = stringParam(req, "artist");
  const album = stringParam(req, "album");
  const artworkUrl = stringParam(req, "artwork");
  recordPlay(db, {
    userId: req.sessionUserId,
    videoId,
    title,
    artist,
    album,
    artworkUrl,
    durationSeconds: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
    source: req.authVia === "api-key" ? "api" : "app",
    apiKeyId: req.apiKeyId ?? null,
  });

}

export function createMediaRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "media", windowMs: 60_000, max: 300 });
  const resolveLimiter = rateLimit({ name: "media-resolve", windowMs: 60_000, max: 120 });

  /**
   * Resolves a playback URL with the linked YouTube account's OAuth token.
   *
   * The browser cannot do this itself: YouTube rejects OAuth on the web and
   * mobile InnerTube clients, and only the TVHTML5 client accepts it. That
   * client also bypasses the anonymous "confirm you're not a bot" wall on
   * gated music tracks, which is why resolution lives server-side.
   *
   * The returned URL is a short-lived googlevideo CDN link (no credentials) —
   * the browser plays it through `GET /stream` below.
   */
  router.post("/resolve", requireAuth, resolveLimiter, async (req: Request, res: Response) => {
    const videoId = typeof req.body?.videoId === "string" ? req.body.videoId : "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      res.status(400).json({ error: "A valid YouTube videoId is required." });
      return;
    }

    const quality = req.body?.quality === "high" ? "high" : "normal";
    // Optional browser-minted BotGuard token; the server cannot produce one
    // that YouTube accepts, but this request can carry the browser's.
    const poToken =
      typeof req.body?.poToken === "string" && req.body.poToken.length <= 4096
        ? req.body.poToken
        : null;
    const resolution = await resolveYouTubePlayback(
      db,
      config,
      req.sessionUserId!,
      videoId,
      quality,
      { poToken },
    );
    if (!resolution.ok) {
      // 401 from YouTube means the saved YouTube credential is missing or
      // stale, not that this app's session is invalid — never surface it as
      // a 401 here. The attempt list says which client refused what, which is
      // what the UI needs to point at the right fix.
      res.status(502).json({
        error: resolution.reason,
        attempts: resolution.attempts,
      });
      return;
    }

    res.setHeader("cache-control", "no-store");
    res.json(resolution.playback);
  });

  router.get("/stream", limiter, async (req: Request, res: Response) => {
    const url = parseStreamUrl(req.query.url);
    if (!url) {
      res.status(400).json({ error: "Invalid media URL." });
      return;
    }

    const upstreamHeaders: Record<string, string> = {
      "user-agent":
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : "Mozilla/5.0",
    };
    // `clen` is the exact file length the player declared for this signature.
    // Some videos are only served up to a point, so ask for no more than the
    // CDN will hand over and describe the resource with that shorter length.
    const declared = Number(url.searchParams.get("clen"));
    const served = await servedContentLength(url, declared);
    const bounded = boundUpstreamRange(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
    );
    const rangeStart = Number(/^bytes=(\d+)-/.exec(bounded)?.[1] ?? 0);
    if (served > 0 && Number.isSafeInteger(rangeStart) && rangeStart >= served) {
      res.status(416).setHeader("content-range", `bytes */${served}`);
      res.end();
      return;
    }
    upstreamHeaders.range = `bytes=${rangeStart}-${Math.min(
      rangeStart + UPSTREAM_CHUNK_BYTES - 1,
      (served > 0 ? served : rangeStart + UPSTREAM_CHUNK_BYTES) - 1,
    )}`;

    let upstream: globalThis.Response;
    try {
      upstream = await fetchAllowlisted(
        url,
        { headers: upstreamHeaders, signal: AbortSignal.timeout(60_000) },
        { isAllowed: isMediaHopAllowed },
      );
      if (upstream.status === 403) {
        // Retry once with YouTube origin headers; some googlevideo CDN nodes
        // reject bare server-side fetches without them.
        upstream = await fetchAllowlisted(
          url,
          {
            headers: {
              ...upstreamHeaders,
              origin: "https://music.youtube.com",
              referer: "https://music.youtube.com/",
            },
            signal: AbortSignal.timeout(60_000),
          },
          { isAllowed: isMediaHopAllowed },
        );
      }
    } catch (error) {
      logger.warn("media.stream fetch failed", { error });
      res.status(502).json({ error: "Audio source is unavailable." });
      return;
    }

    if (upstream.status >= 400) {
      const bodySnippet = await upstream.text().catch(() => "");
      logger.warn("media.stream upstream failure", {
        status: upstream.status,
        host: url.hostname,
        params: [...url.searchParams.keys()].join(","),
        body: bodySnippet.slice(0, 300),
      });
      res.status(upstream.status === 403 || upstream.status === 404 ? 502 : upstream.status)
        .json({ error: `Audio source returned HTTP ${upstream.status}.` });
      return;
    }

    recordStreamPlay(req, db, url);

    res.status(upstream.status);
    for (const header of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (served > 0 && served < declared) {
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) res.setHeader("content-range", contentRange.replace(/\/\d+$/, `/${served}`));
    }
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("x-content-type-options", "nosniff");

    if (!upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    const abort = () => {
      nodeStream.destroy(new Error("Client closed the connection."));
    };
    req.on("close", abort);
    try {
      await pipeline(nodeStream, res);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("Client closed"))) {
        logger.debug("media.stream pipeline ended early", { error });
      }
    } finally {
      req.off("close", abort);
    }
  });

  return router;
}

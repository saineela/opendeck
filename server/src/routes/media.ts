import express, { type Request, type Response, type Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { fetchAllowlisted } from "../services/safeFetch.js";
import { recordPlay } from "../services/playHistory.js";
import { logger } from "../logger.js";

/**
 * Streams resolved YouTube audio bytes server-side (CORS-free for the
 * browser), replacing the desktop app's `fetch_audio_source` /
 * `download_audio_source` Rust commands and local media server.
 *
 * Only googlevideo CDN `videoplayback` URLs are accepted.
 */

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

export function createMediaRoutes(db: Db): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "media", windowMs: 60_000, max: 300 });

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
    const range = req.headers.range;
    if (typeof range === "string") {
      upstreamHeaders.range = range;
    }

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

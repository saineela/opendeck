import express, { type Request, type Response, type Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rateLimit } from "../middleware/rateLimit.js";
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
    const host = url.hostname.toLowerCase();
    const allowed = host === "googlevideo.com" || host.endsWith(".googlevideo.com");
    if (!allowed) return null;
    if (url.pathname !== "/videoplayback") return null;
    return url;
  } catch {
    return null;
  }
}

export function createMediaRoutes(): Router {
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
      upstream = await fetch(url, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(60_000),
      });
      if (upstream.status === 403) {
        // Retry once with YouTube origin headers; some googlevideo CDN nodes
        // reject bare server-side fetches without them.
        upstream = await fetch(url, {
          headers: {
            ...upstreamHeaders,
            origin: "https://music.youtube.com",
            referer: "https://music.youtube.com/",
          },
          signal: AbortSignal.timeout(60_000),
        });
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

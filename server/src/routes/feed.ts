import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";
import { getLibrarySnapshot } from "../services/libraryStore.js";
import {
  FeedError,
  fetchHomeFeed,
  fetchPlaylistDetail,
  fetchWatchNext,
} from "../services/feed.js";

/**
 * Feed API — the data behind the home screen's shelves, so a client (or an
 * integration script) can render "Made for you", "Recently played", and a
 * playlist's songs without driving the InnerTube proxy itself.
 *
 *   GET /api/feed/home       normalized home shelves (sections + items)
 *   GET /api/feed/next       watch-next recommendations for a seed video
 *   GET /api/feed/playlist   playlist header (thumbnail) + ordered songs
 *   GET /api/feed/playlists  this account's library playlists with tracks
 *
 * Every route requires a session; upstream calls reuse the proxy's host
 * allowlist and Bearer injection. The local-playlist route never leaves the
 * database.
 */

const VIDEO_ID = /^[\w-]{6,20}$/;
// browse ids: VLRD…/PL…/MPRE…/UC… plus FEmusic_* shelves; base64url-ish.
const BROWSE_ID = /^[\w-]{1,200}$/;
// InnerTube `params` values are base64 with percent-encoding (e.g. ggMEgALjBA%3D%3D).
const PARAMS = /^[\w%=-]{1,512}$/;
const HL = /^[a-z]{2,3}$/;
const GL = /^[A-Z]{2}$/;

/** Optional `hl`/`gl` query pair validated together (InnerTube context). */
function localeFrom(req: Request): { hl: string; gl: string } | null {
  const hl = req.query.hl;
  const gl = req.query.gl;
  if (hl !== undefined && (typeof hl !== "string" || !HL.test(hl))) return null;
  if (gl !== undefined && (typeof gl !== "string" || !GL.test(gl))) return null;
  return { hl: typeof hl === "string" ? hl : "en", gl: typeof gl === "string" ? gl : "US" };
}

export function createFeedRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "feed", windowMs: 60_000, max: 120 });

  /** Maps store/upstream errors onto HTTP without leaking internals. */
  function send(res: Response, error: unknown): void {
    if (error instanceof FeedError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error("feed.unhandled_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Unable to load the feed." });
  }

  const userId = (req: Request): string => req.sessionUserId!;

  router.get("/home", requireAuth, limiter, async (req: Request, res: Response) => {
    const locale = localeFrom(req);
    if (!locale) {
      res.status(400).json({ error: "Invalid hl/gl locale." });
      return;
    }
    try {
      const sections = await fetchHomeFeed(db, config, userId(req), locale);
      res.json({ sections });
    } catch (error) {
      send(res, error);
    }
  });

  router.get("/next", requireAuth, limiter, async (req: Request, res: Response) => {
    const videoId = req.query.videoId;
    if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) {
      res.status(400).json({ error: "A `videoId` query parameter is required." });
      return;
    }
    const locale = localeFrom(req);
    if (!locale) {
      res.status(400).json({ error: "Invalid hl/gl locale." });
      return;
    }
    try {
      const items = await fetchWatchNext(db, config, userId(req), videoId, locale);
      res.json({ items });
    } catch (error) {
      send(res, error);
    }
  });

  router.get("/playlist", requireAuth, limiter, async (req: Request, res: Response) => {
    const browseId = req.query.browseId;
    if (typeof browseId !== "string" || !BROWSE_ID.test(browseId)) {
      res.status(400).json({ error: "A `browseId` query parameter is required." });
      return;
    }
    const params = req.query.params;
    if (params !== undefined && (typeof params !== "string" || !PARAMS.test(params))) {
      res.status(400).json({ error: "Invalid `params` value." });
      return;
    }
    const locale = localeFrom(req);
    if (!locale) {
      res.status(400).json({ error: "Invalid hl/gl locale." });
      return;
    }
    try {
      const playlist = await fetchPlaylistDetail(
        db,
        config,
        userId(req),
        browseId,
        typeof params === "string" ? params : null,
        locale,
      );
      res.json({ playlist });
    } catch (error) {
      send(res, error);
    }
  });

  /** Library playlists with their tracks inline — no upstream call. */
  router.get("/playlists", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      const snapshot = getLibrarySnapshot(db, userId(req));
      res.json({
        playlists: snapshot.playlists,
        counts: snapshot.counts,
      });
    } catch (error) {
      send(res, error);
    }
  });

  return router;
}

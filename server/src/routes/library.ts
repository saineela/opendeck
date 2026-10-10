import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  LibraryError,
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  getLibrarySnapshot,
  getPlaylist,
  likeTrack,
  listLikedSongs,
  listPlaylists,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  replaceLibrarySnapshot,
  unlikeTrack,
  updatePlaylist,
} from "../services/libraryStore.js";

/**
 * Per-user library API — playlists, their tracks, and liked songs.
 *
 * Every route requires a session and is scoped to `req.sessionUserId`; there
 * is no route that accepts a user id from the client, so one account cannot
 * address another's rows even with a crafted URL.
 */
export function createLibraryRoutes(db: Db): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "library", windowMs: 60_000, max: 300 });

  /** Maps store errors onto HTTP without leaking internals. */
  function send(res: Response, error: unknown): void {
    if (error instanceof LibraryError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (typeof (error as { code?: string })?.code === "string" && (error as { code: string }).code.includes("UNIQUE")) {
      res.status(409).json({ error: "That playlist id is already in use." });
      return;
    }
    logger.error("library.unhandled_error", { error });
    res.status(500).json({ error: "Unable to update your library." });
  }

  const userId = (req: Request): string => req.sessionUserId!;

  /** Express 5 types route params as `string | string[]`; normalise to one. */
  const param = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

  router.get("/", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json(getLibrarySnapshot(db, userId(req)));
    } catch (error) {
      send(res, error);
    }
  });

  /** Bulk replace — the sync endpoint the client pushes its snapshot to. */
  router.post("/sync", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json(replaceLibrarySnapshot(db, userId(req), req.body?.snapshot ?? req.body));
    } catch (error) {
      send(res, error);
    }
  });

  router.get("/playlists", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json({ playlists: listPlaylists(db, userId(req)) });
    } catch (error) {
      send(res, error);
    }
  });

  router.post("/playlists", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.status(201).json({ playlist: createPlaylist(db, userId(req), req.body ?? {}) });
    } catch (error) {
      send(res, error);
    }
  });

  router.get("/playlists/:id", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      const detail = getPlaylist(db, userId(req), param(req.params.id));
      if (!detail) {
        res.status(404).json({ error: "Playlist not found." });
        return;
      }
      res.json(detail);
    } catch (error) {
      send(res, error);
    }
  });

  router.patch("/playlists/:id", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json({ playlist: updatePlaylist(db, userId(req), param(req.params.id), req.body ?? {}) });
    } catch (error) {
      send(res, error);
    }
  });

  router.delete("/playlists/:id", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      if (!deletePlaylist(db, userId(req), param(req.params.id))) {
        res.status(404).json({ error: "Playlist not found." });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      send(res, error);
    }
  });

  router.post("/playlists/:id/tracks", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json(
        addTracksToPlaylist(db, userId(req), param(req.params.id), req.body?.tracks ?? req.body),
      );
    } catch (error) {
      send(res, error);
    }
  });

  router.delete("/playlists/:id/tracks/:trackId", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      const removed = removeTrackFromPlaylist(db, userId(req), param(req.params.id), param(req.params.trackId));
      res.json({ ok: removed });
    } catch (error) {
      send(res, error);
    }
  });

  router.post("/playlists/:id/reorder", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json(reorderPlaylistTracks(db, userId(req), param(req.params.id), req.body?.trackIds));
    } catch (error) {
      send(res, error);
    }
  });

  router.get("/likes", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json({ likedSongs: listLikedSongs(db, userId(req)) });
    } catch (error) {
      send(res, error);
    }
  });

  router.put("/likes/:trackId", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      const trackId = param(req.params.trackId);
      const track = req.body && typeof req.body === "object" ? req.body : { id: trackId };
      // The path wins over a mismatched body id.
      res.json(likeTrack(db, userId(req), { ...track, id: trackId }));
    } catch (error) {
      send(res, error);
    }
  });

  router.delete("/likes/:trackId", requireAuth, limiter, (req: Request, res: Response) => {
    try {
      res.json(unlikeTrack(db, userId(req), param(req.params.trackId)));
    } catch (error) {
      send(res, error);
    }
  });

  return router;
}

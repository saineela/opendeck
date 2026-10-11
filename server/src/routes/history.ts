import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { clearPlays, getPlayStats, listPlays } from "../services/playHistory.js";
import { logger } from "../logger.js";

/**
 * Play history for the signed-in account. Plays are recorded by
 * `GET /api/media/stream` — both app playback and plays made through the
 * HTTP API with a bearer key land here, the latter attributed to the key.
 */
export function createHistoryRoutes(db: Db): Router {
  const router = express.Router();
  const listLimit = rateLimit({ name: "history", windowMs: 60_000, max: 180 });

  router.get("/", requireAuth, listLimit, (req: Request, res: Response) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit) || 50, 1), 200) : 50;
    const rawBefore = Number(req.query.before);
    const before = Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : undefined;
    const { plays, hasMore } = listPlays(db, req.sessionUserId!, { limit, before });
    res.json({
      plays,
      hasMore,
      nextCursor: plays.length > 0 ? plays[plays.length - 1].playedAt : null,
    });
  });

  router.get("/stats", requireAuth, listLimit, (req: Request, res: Response) => {
    res.json(getPlayStats(db, req.sessionUserId!));
  });

  router.delete("/", requireAuth, listLimit, (req: Request, res: Response) => {
    const removed = clearPlays(db, req.sessionUserId!);
    logger.info("history.cleared", { userId: req.sessionUserId, removed });
    res.json({ ok: true, removed });
  });

  return router;
}

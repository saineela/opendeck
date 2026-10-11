import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireAuth, requireSession } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  deleteRecommendation,
  ensureVapidKeys,
  listDirectory,
  listRecommendations,
  listSentRecommendations,
  markRecommendationRead,
  removePushSubscription,
  savePushSubscription,
  sendPushToUser,
  sendRecommendation,
} from "../services/recommendations.js";
import { logger } from "../logger.js";

function stringParam(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function optionalNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Song recommendations between registered accounts, with Web Push delivery.
 *
 * Everything accepts a session cookie **or** a bearer API key (`requireAuth`)
 * so a future mobile client can reuse the surface unchanged. Push
 * subscription management stays cookie-session-only — a leaked key must not
 * be able to re-point someone's notifications.
 */
export function createRecommendationsRoutes(db: Db): Router {
  const router = express.Router();
  const sendLimit = rateLimit({ name: "recommend-send", windowMs: 60_000, max: 30 });
  const readLimit = rateLimit({ name: "recommend-read", windowMs: 60_000, max: 180 });

  // Directory of registered accounts (id + name + picture only) so the
  // sender can pick a recipient. No emails leak here.
  router.get("/directory", requireAuth, readLimit, (req: Request, res: Response) => {
    res.json({ users: listDirectory(db, req.sessionUserId!) });
  });

  // Sent list — before "/:id" so "sent" is never read as an id.
  router.get("/sent", requireAuth, readLimit, (req: Request, res: Response) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit) || 50, 1), 200) : 50;
    res.json({ recommendations: listSentRecommendations(db, req.sessionUserId!, limit) });
  });

  router.get("/", requireAuth, readLimit, (req: Request, res: Response) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit) || 50, 1), 200) : 50;
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    res.json(listRecommendations(db, req.sessionUserId!, { limit, unreadOnly }));
  });

  router.post("/", requireAuth, sendLimit, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recipientId = stringParam(body.recipientId, 64);
    const videoId = stringParam(body.videoId, 64);
    const title = stringParam(body.title, 300);
    if (!recipientId || !videoId || !title) {
      res.status(400).json({ error: "recipientId, videoId, and title are required." });
      return;
    }
    const recipient = db
      .prepare("SELECT id, name FROM users WHERE id = ?")
      .get(recipientId) as { id: string; name: string } | undefined;
    if (!recipient) {
      res.status(404).json({ error: "No registered user with that id." });
      return;
    }
    if (recipient.id === req.sessionUserId) {
      res.status(400).json({ error: "You cannot recommend a song to yourself." });
      return;
    }

    const recommendation = sendRecommendation(db, {
      senderUserId: req.sessionUserId!,
      recipientUserId: recipient.id,
      videoId,
      title,
      artist: stringParam(body.artist, 200),
      album: stringParam(body.album, 300),
      artworkUrl: stringParam(body.artworkUrl, 2048),
      durationSeconds: optionalNumber(body.durationSeconds),
      note: stringParam(body.note, 500),
    });
    logger.info("recommendation.sent", {
      sender: req.sessionUserId,
      recipient: recipient.id,
      videoId: recommendation.videoId,
    });

    // Push is best-effort and never blocks the response.
    const senderName = (db.prepare("SELECT name FROM users WHERE id = ?").get(req.sessionUserId!) as
      | { name: string }
      | undefined)?.name ?? "Someone";
    void sendPushToUser(db, recipient.id, {
      title: `${senderName} recommended a song`,
      body: recommendation.artist ? `${recommendation.title} — ${recommendation.artist}` : recommendation.title,
      icon: recommendation.artworkUrl ?? undefined,
      data: { kind: "recommendation", id: recommendation.id },
    });

    res.status(201).json({ recommendation });
  });

  router.post("/:id/read", requireAuth, readLimit, (req: Request, res: Response) => {
    const ok = markRecommendationRead(db, req.sessionUserId!, String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: "Recommendation not found." });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/:id", requireAuth, readLimit, (req: Request, res: Response) => {
    const removed = deleteRecommendation(db, req.sessionUserId!, String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: "Recommendation not found." });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

/**
 * Web Push subscription management, mounted at `/api/push`.
 *
 * Cookie-session-only: re-pointing someone's notifications is a
 * credential-adjacent action, so bearer API keys are refused (same policy
 * as API-key management and TOTP routes).
 */
export function createPushRoutes(db: Db): Router {
  const router = express.Router();
  const pushLimit = rateLimit({ name: "push-sub", windowMs: 60_000, max: 30 });

  router.get("/vapid-public-key", requireSession, pushLimit, (_req: Request, res: Response) => {
    try {
      res.json({ publicKey: ensureVapidKeys(db).publicKey });
    } catch (error) {
      logger.warn("push.vapid failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "Push notifications are not available." });
    }
  });

  router.post("/subscribe", requireSession, pushLimit, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = stringParam(body.endpoint, 2048);
    const p256dh = stringParam(body.keys?.p256dh, 256);
    const auth = stringParam(body.keys?.auth, 256);
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: "endpoint, keys.p256dh, and keys.auth are required." });
      return;
    }
    savePushSubscription(db, req.sessionUserId!, { endpoint, keys: { p256dh, auth } });
    logger.info("push.subscribed", { userId: req.sessionUserId });
    res.status(201).json({ ok: true });
  });

  router.post("/unsubscribe", requireSession, pushLimit, (req: Request, res: Response) => {
    const endpoint = stringParam((req.body ?? {}).endpoint, 2048);
    if (!endpoint) {
      res.status(400).json({ error: "endpoint is required." });
      return;
    }
    res.json({ ok: true, removed: removePushSubscription(db, req.sessionUserId!, endpoint) });
  });

  return router;
}

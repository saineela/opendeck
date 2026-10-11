import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireAdmin, requireAuth } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  cacheGet,
  cacheSet,
  clearCache,
  getCacheStats,
  setCacheMaxBytes,
} from "../services/cacheStore.js";
import {
  clearImageCache,
  getImageCacheStats,
  setImageCacheMaxBytes,
} from "../services/imageCache.js";
import { logger } from "../logger.js";

const MAX_SETTING_VALUE_BYTES = 128 * 1024;
const MAX_KEY_LENGTH = 256;

function namespaceFor(req: Request): string {
  return req.sessionUserId ? `u:${req.sessionUserId}` : "anon";
}

function readKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const key = (body as Record<string, unknown>).key;
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) return null;
  return key;
}

export function createCacheRoutes(db: Db): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "cache", windowMs: 60_000, max: 600 });

  router.post("/get", limiter, (req: Request, res: Response) => {
    const key = readKey(req.body);
    if (!key) {
      res.status(400).json({ error: "A valid cache key is required." });
      return;
    }
    res.json({ value: cacheGet(db, namespaceFor(req), key) });
  });

  router.post("/set", limiter, (req: Request, res: Response) => {
    const key = readKey(req.body);
    const value = (req.body as Record<string, unknown> | undefined)?.value;
    if (!key || typeof value !== "string") {
      res.status(400).json({ error: "A valid cache key and string value are required." });
      return;
    }
    if (Buffer.byteLength(value, "utf8") > 64 * 1024 * 1024) {
      res.status(413).json({ error: "Cache entry too large." });
      return;
    }
    res.json(cacheSet(db, namespaceFor(req), key, value));
  });

  router.post("/stats", limiter, (_req: Request, res: Response) => {
    res.json(getCacheStats(db));
  });

  router.post("/setMaxBytes", requireAuth, limiter, (req: Request, res: Response) => {
    const maxBytes = (req.body as Record<string, unknown> | undefined)?.maxBytes;
    if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      res.status(400).json({ error: "maxBytes must be a positive number." });
      return;
    }
    try {
      res.json(setCacheMaxBytes(db, maxBytes));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid value." });
    }
  });

  router.post("/clear", limiter, (req: Request, res: Response) => {
    // Only clears the caller's own namespace (matches sign-in/sign-out cache
    // clearing in the original app without nuking other users' caches).
    res.json(clearCache(db, namespaceFor(req)));
  });

  /* ------------------------------------------------------------------ *
   * Artwork cache — global rather than namespaced, so it is administered
   * globally too: anyone signed in may read the usage (the settings page
   * shows it to everyone), but the budget and the manual format are admin
   * only, because both affect every account on the instance.
   * ------------------------------------------------------------------ */

  router.post("/artwork/stats", requireAuth, limiter, (_req: Request, res: Response) => {
    res.json(getImageCacheStats(db));
  });

  router.post("/artwork/setMaxBytes", requireAdmin(db), limiter, (req: Request, res: Response) => {
    const maxBytes = (req.body as Record<string, unknown> | undefined)?.maxBytes;
    if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      res.status(400).json({ error: "maxBytes must be a positive number." });
      return;
    }
    const stats = setImageCacheMaxBytes(db, maxBytes);
    logger.info("imageCache.budget.updated", {
      adminId: req.sessionUserId,
      maxBytes: stats.maxBytes,
    });
    res.json(stats);
  });

  router.post("/artwork/format", requireAdmin(db), limiter, (req: Request, res: Response) => {
    const stats = clearImageCache(db);
    logger.info("imageCache.formatted", { adminId: req.sessionUserId });
    res.json(stats);
  });

  return router;
}

export function createSettingsRoutes(db: Db): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "settings", windowMs: 60_000, max: 300 });

  router.post("/get", requireAuth, limiter, (req: Request, res: Response) => {
    const key = readKey(req.body);
    if (!key) {
      res.status(400).json({ error: "A valid setting key is required." });
      return;
    }
    const row = db
      .prepare("SELECT value FROM app_settings WHERE user_id = ? AND key = ?")
      .get(req.sessionUserId!, key) as { value: string } | undefined;
    res.json({ value: row ? (JSON.parse(row.value) as unknown) : null });
  });

  router.post("/set", requireAuth, limiter, (req: Request, res: Response) => {
    const key = readKey(req.body);
    const value = (req.body as Record<string, unknown> | undefined)?.value;
    if (!key || value === undefined) {
      res.status(400).json({ error: "A valid setting key and value are required." });
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      res.status(400).json({ error: "Setting value must be JSON-serializable." });
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SETTING_VALUE_BYTES) {
      res.status(413).json({ error: "Setting value too large." });
      return;
    }
    db.prepare(
      `INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(req.sessionUserId!, key, serialized, Date.now());
    res.json({ ok: true });
  });

  router.post("/remove", requireAuth, limiter, (req: Request, res: Response) => {
    const key = readKey(req.body);
    if (!key) {
      res.status(400).json({ error: "A valid setting key is required." });
      return;
    }
    db.prepare("DELETE FROM app_settings WHERE user_id = ? AND key = ?").run(
      req.sessionUserId!,
      key,
    );
    res.json({ ok: true });
  });

  return router;
}

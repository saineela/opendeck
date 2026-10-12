import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireSession } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { getKeyPlayStats } from "../services/playHistory.js";
import { logger } from "../logger.js";

/**
 * Per-account API keys: long-lived bearer tokens (`Authorization: Bearer
 * odk_…`) that authenticate as the owning user on every session-authenticated
 * endpoint. Only the SHA-256 hash is stored; the plaintext key is returned
 * exactly once at creation. Management routes demand a real browser session
 * (`requireSession`) so a leaked key cannot mint or revoke keys.
 */
export function createApiKeysRoutes(db: Db): Router {
  const router = express.Router();
  const listLimit = rateLimit({ name: "apikeys", windowMs: 60_000, max: 60 });
  const createLimit = rateLimit({ name: "apikeys-create", windowMs: 60_000, max: 10 });

  interface KeyRow {
    id: string;
    label: string;
    key_prefix: string;
    created_at: number;
    last_used_at: number | null;
  }

  router.get("/", requireSession, listLimit, (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT id, label, key_prefix, created_at, last_used_at
         FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(req.sessionUserId!) as unknown as KeyRow[];
    // Report successful API request and playback stats for each account key.
    const stats = getKeyPlayStats(db, req.sessionUserId!);
    res.json({
      keys: rows.map((row) => ({
        id: row.id,
        label: row.label,
        keyPrefix: row.key_prefix,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        stats: stats.get(row.id) ?? {
          totalRequests: 0,
          requestsLast7Days: 0,
          lastRequestAt: null,
          requestsByRoute: [],
          totalPlays: 0,
          playsLast7Days: 0,
          lastPlayedAt: null,
        },
      })),
    });
  });

  router.post("/", requireSession, createLimit, (req: Request, res: Response) => {
    const label = (req.body as Record<string, unknown> | undefined)?.label;
    if (typeof label !== "string" || !label.trim() || label.trim().length > 80) {
      res.status(400).json({ error: "A label of 1-80 characters is required." });
      return;
    }
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
      .get(req.sessionUserId!) as { n: number };
    if (existing.n >= 25) {
      res.status(429).json({ error: "API key limit reached (25). Revoke one first." });
      return;
    }

    const key = `odk_${crypto.randomBytes(32).toString("base64url")}`;
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO api_keys (id, user_id, label, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, req.sessionUserId!, label.trim(), keyHash, key.slice(0, 12), now);
    logger.info("apikeys.created", { userId: req.sessionUserId, keyId: id });

    // The only time the plaintext key leaves the server.
    res.status(201).json({
      id,
      label: label.trim(),
      key,
      keyPrefix: key.slice(0, 12),
      createdAt: now,
    });
  });

  router.delete("/:id", requireSession, listLimit, (req: Request, res: Response) => {
    const result = db
      .prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
      .run(String(req.params.id), req.sessionUserId!);
    if (result.changes === 0) {
      res.status(404).json({ error: "API key not found." });
      return;
    }
    logger.info("apikeys.revoked", { userId: req.sessionUserId, keyId: req.params.id });
    res.json({ ok: true });
  });

  return router;
}

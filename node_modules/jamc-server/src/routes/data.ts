import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { requireAuth } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  cacheGet,
  cacheSet,
  clearCache,
  getCacheStats,
  setCacheMaxBytes,
} from "../services/cacheStore.js";
import {
  deleteLastFmSession,
  exchangeAuthToken,
  getAuthToken,
  loadLastFmSession,
  saveLastFmSession,
  scrobble,
  updateNowPlaying,
  type LastFmScrobbleInput,
  type LastFmTrackInput,
} from "../services/lastfm.js";
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

  router.post("/clear", requireAuth, limiter, (req: Request, res: Response) => {
    db.prepare("DELETE FROM app_settings WHERE user_id = ?").run(req.sessionUserId!);
    res.json({ ok: true });
  });

  return router;
}

function lastfmSessionOrError(db: Db, userId: string, res: Response) {
  const session = loadLastFmSession(db, userId);
  if (!session) {
    res.status(409).json({ error: "Last.fm is not connected." });
    return null;
  }
  return session;
}

function requireLastfmConfig(config: ServerConfig, res: Response): boolean {
  if (!config.lastfm.configured) {
    res.status(503).json({
      error: "Last.fm is not configured on this server (set LASTFM_API_KEY and LASTFM_API_SECRET).",
    });
    return false;
  }
  return true;
}

function cleanTrackInput(body: unknown): LastFmTrackInput | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.artist !== "string" || !record.artist.trim()) return null;
  if (typeof record.track !== "string" || !record.track.trim()) return null;
  return {
    artist: record.artist,
    track: record.track,
    album: typeof record.album === "string" && record.album ? record.album : undefined,
    duration: typeof record.duration === "number" ? record.duration : undefined,
  };
}

export function createLastFmRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "lastfm", windowMs: 60_000, max: 120 });

  router.get("/status", requireAuth, limiter, (req: Request, res: Response) => {
    if (!config.lastfm.configured) {
      res.json({ configured: false, session: null });
      return;
    }
    const session = loadLastFmSession(db, req.sessionUserId!);
    res.json({
      configured: true,
      session: session ? { username: session.username } : null,
    });
  });

  router.post("/start", requireAuth, limiter, async (_req: Request, res: Response) => {
    if (!requireLastfmConfig(config, res)) return;
    try {
      const token = await getAuthToken(config);
      res.json({
        token,
        authUrl: `https://www.last.fm/api/auth/?api_key=${config.lastfm.apiKey}&token=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      logger.error("lastfm.start failed", { error });
      res.status(502).json({ error: error instanceof Error ? error.message : "Last.fm request failed." });
    }
  });

  router.post("/complete", requireAuth, limiter, async (req: Request, res: Response) => {
    if (!requireLastfmConfig(config, res)) return;
    const token = (req.body as Record<string, unknown> | undefined)?.token;
    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "An auth token is required." });
      return;
    }
    try {
      const session = await exchangeAuthToken(config, token);
      saveLastFmSession(db, req.sessionUserId!, session);
      res.json({ username: session.username });
    } catch (error) {
      logger.error("lastfm.complete failed", { error });
      res.status(502).json({ error: error instanceof Error ? error.message : "Last.fm sign-in failed." });
    }
  });

  router.post("/disconnect", requireAuth, limiter, (req: Request, res: Response) => {
    deleteLastFmSession(db, req.sessionUserId!);
    res.json({ ok: true });
  });

  router.post("/now-playing", requireAuth, limiter, async (req: Request, res: Response) => {
    if (!requireLastfmConfig(config, res)) return;
    const session = lastfmSessionOrError(db, req.sessionUserId!, res);
    if (!session) return;
    const input = cleanTrackInput(req.body);
    if (!input) {
      res.status(400).json({ error: "Artist and track are required." });
      return;
    }
    try {
      await updateNowPlaying(config, session, input);
      res.json({ ok: true });
    } catch (error) {
      logger.warn("lastfm.now-playing failed", { error });
      res.status(502).json({ error: error instanceof Error ? error.message : "Last.fm request failed." });
    }
  });

  router.post("/scrobble", requireAuth, limiter, async (req: Request, res: Response) => {
    if (!requireLastfmConfig(config, res)) return;
    const session = lastfmSessionOrError(db, req.sessionUserId!, res);
    if (!session) return;
    const input = cleanTrackInput(req.body);
    const timestamp = (req.body as Record<string, unknown> | undefined)?.timestamp;
    if (!input || typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      res.status(400).json({ error: "Artist, track and timestamp are required." });
      return;
    }
    const scrobbleInput: LastFmScrobbleInput = { ...input, timestamp: Math.floor(timestamp) };
    try {
      await scrobble(config, session, scrobbleInput);
      res.json({ ok: true });
    } catch (error) {
      logger.warn("lastfm.scrobble failed", { error });
      res.status(502).json({ error: error instanceof Error ? error.message : "Last.fm request failed." });
    }
  });

  return router;
}

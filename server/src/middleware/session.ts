import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { logger } from "../logger.js";

export const SESSION_COOKIE = "od_sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXTEND_AFTER_MS = 15 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

export interface AuthedUser {
  id: string;
  name: string;
  email: string | null;
  picture: string | null;
}

/** How the current request authenticated: a cookie session or an API key. */
export type AuthVia = "session" | "api-key";

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  last_seen_at: number;
  name: string;
  email: string | null;
  picture: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthedUser | null;
      sessionUserId?: string | null;
      authVia?: AuthVia | null;
      /** Set when authVia === "api-key": the key that authenticated this request. */
      apiKeyId?: string | null;
    }
  }
}

export function createSession(db: Db, userId: string): string {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, userId, now, now + SESSION_TTL_MS, now);
  return sessionId;
}

export function destroySession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function destroyAllUserSessions(db: Db, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function setSessionCookie(res: Response, config: ServerConfig, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response, config: ServerConfig): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https://"),
    path: "/",
  });
}

export function getSessionId(req: Request): string | null {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1));
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/** Resolve the current request's session, sliding expiry as needed. */
export function loadSession(db: Db, sessionId: string): AuthedUser | null {
  const row = db.prepare(
    `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at,
            u.name, u.email, u.picture
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
  ).get(sessionId) as SessionRow | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    destroySession(db, sessionId);
    return null;
  }

  if (now - row.last_seen_at > TOUCH_INTERVAL_MS || row.expires_at - now < EXTEND_AFTER_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
      now,
      now + SESSION_TTL_MS,
      sessionId,
    );
  }

  return { id: row.user_id, name: row.name, email: row.email, picture: row.picture };
}

/**
 * Resolves `Authorization: Bearer odk_…` API keys to their owning account.
 * Only the SHA-256 hash is stored, so a database leak does not leak usable
 * keys. `last_used_at` is touched at most once a minute to avoid a write per
 * request.
 */
function loadApiKeyUser(
  db: Db,
  presented: string,
): { user: AuthedUser; keyId: string } | null {
  if (!presented.startsWith("odk_") || presented.length > 128) return null;
  const keyHash = crypto.createHash("sha256").update(presented).digest("hex");
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.picture, k.id AS key_id, k.last_used_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`,
    )
    .get(keyHash) as
    | {
        id: string;
        name: string;
        email: string | null;
        picture: string | null;
        key_id: string;
        last_used_at: number | null;
      }
    | undefined;  if (!row) return null;

  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.key_id);
  }
  return {
    user: { id: row.id, name: row.name, email: row.email, picture: row.picture },
    keyId: row.key_id,
  };
}

function bearerApiKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match ? match[1] : null;
}

export function sessionMiddleware(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const sessionId = getSessionId(req);
    const user = sessionId ? loadSession(db, sessionId) : null;
    if (user) {
      req.authUser = user;
      req.sessionUserId = user.id;
      req.authVia = "session";
      next();
      return;
    }
    const apiKey = bearerApiKey(req);
    const keyAuth = apiKey ? loadApiKeyUser(db, apiKey) : null;
    req.authUser = keyAuth?.user ?? null;
    req.sessionUserId = keyAuth?.user.id ?? null;
    req.authVia = keyAuth ? "api-key" : null;
    req.apiKeyId = keyAuth?.keyId ?? null;
    if (keyAuth) {
      res.once("finish", () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            const route = `${req.baseUrl}${req.route?.path ?? req.path}`.slice(0, 255);
            const now = Date.now();
            const day = Math.floor(now / 86_400_000);
            db.prepare(
              `INSERT INTO api_key_usage (api_key_id, route, day, request_count, last_used_at)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(api_key_id, route, day) DO UPDATE SET
                 request_count = request_count + 1,
                 last_used_at = excluded.last_used_at`,
            ).run(keyAuth.keyId, route, day, now);
          }
        } catch (error) {
          // Usage tracking is best-effort and must not disrupt a completed response.
          logger.warn("apiKeyUsage.record failed", {
            keyId: keyAuth.keyId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: "Sign in is required." });
    return;
  }
  next();
}

/**
 * Routes that mutate credentials or mint credentials (API-key management,
 * TOTP enrolment) demand a real browser session: a leaked API key must not
 * be able to issue more API keys or reconfigure second-factor auth.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authVia !== "session") {
    res.status(401).json({ error: "A signed-in browser session is required." });
    return;
  }
  next();
}

/**
 * Admin gate for the admin panel's API: a real browser session whose owning
 * account carries `role = 'admin'`. API keys are rejected (key management
 * and instance administration both demand the cookie) and non-admins get
 * 403 so a valid session can tell "forbidden" from "signed out".
 */
export function requireAdmin(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser || req.authVia !== "session" || !req.sessionUserId) {
      res.status(401).json({ error: "A signed-in browser session is required." });
      return;
    }
    const row = db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(req.sessionUserId) as { role: string } | undefined;
    if (row?.role !== "admin") {
      res.status(403).json({ error: "Administrator access is required." });
      return;
    }
    next();
  };
}

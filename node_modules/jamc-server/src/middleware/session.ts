import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";

export const SESSION_COOKIE = "jamac_sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXTEND_AFTER_MS = 15 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

export interface AuthedUser {
  id: string;
  name: string;
  email: string | null;
  picture: string | null;
}

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

export function sessionMiddleware(db: Db): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sessionId = getSessionId(req);
    const user = sessionId ? loadSession(db, sessionId) : null;
    req.authUser = user;
    req.sessionUserId = user?.id ?? null;
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

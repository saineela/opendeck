import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../db.js";
import {
  SESSION_COOKIE,
  createSession,
  destroyAllUserSessions,
  destroySession,
  getSessionId,
  loadSession,
} from "./session.js";

let db: Db;
let userId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  userId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  ).run(userId, `sub-${userId}`, "Test User", "t@example.com", Date.now(), Date.now());
});

afterEach(() => {
  db.close();
});

describe("createSession / loadSession", () => {
  it("resolves the signed-in user for a live session", () => {
    const sessionId = createSession(db, userId);
    expect(sessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(loadSession(db, sessionId)).toEqual({
      id: userId,
      name: "Test User",
      email: "t@example.com",
      picture: null,
    });
  });

  it("returns null for unknown sessions", () => {
    expect(loadSession(db, "f".repeat(64))).toBeNull();
  });

  it("expires stale sessions and deletes them", () => {
    const sessionId = createSession(db, userId);
    const past = Date.now() - 1000;
    db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").run(
      past,
      past,
      sessionId,
    );
    expect(loadSession(db, sessionId)).toBeNull();
    const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
    expect(row).toBeUndefined();
  });

  it("slides the expiry when the session is old", () => {
    const sessionId = createSession(db, userId);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    const future = Date.now() + 20 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").run(
      future,
      old,
      sessionId,
    );
    const before = db
      .prepare("SELECT expires_at FROM sessions WHERE id = ?")
      .get(sessionId) as { expires_at: number };
    loadSession(db, sessionId);
    const after = db
      .prepare("SELECT expires_at FROM sessions WHERE id = ?")
      .get(sessionId) as { expires_at: number };
    expect(after.expires_at).toBeGreaterThan(before.expires_at);
    expect(loadSession(db, sessionId)).not.toBeNull();
  });

  it("survives user deletion via cascade only when foreign keys are on", () => {
    const sessionId = createSession(db, userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    expect(loadSession(db, sessionId)).toBeNull();
  });
});

describe("destroySession / destroyAllUserSessions", () => {
  it("revokes a single session", () => {
    const sessionId = createSession(db, userId);
    destroySession(db, sessionId);
    expect(loadSession(db, sessionId)).toBeNull();
  });

  it("revokes every session for a user", () => {
    const first = createSession(db, userId);
    const second = createSession(db, userId);
    destroyAllUserSessions(db, userId);
    expect(loadSession(db, first)).toBeNull();
    expect(loadSession(db, second)).toBeNull();
  });
});

describe("getSessionId", () => {
  function cookieHeader(value: string): string {
    return `other=1; ${SESSION_COOKIE}=${value}; trailing=2`;
  }

  it("accepts a well-formed session id from a cookie header", () => {
    const id = "a1b2c3d4".repeat(8); // 64 hex chars
    expect(getSessionId({ headers: { cookie: cookieHeader(id) } } as never)).toBe(id);
  });

  it("rejects malformed values", () => {
    expect(getSessionId({ headers: {} } as never)).toBeNull();
    expect(getSessionId({ headers: { cookie: `${SESSION_COOKIE}=short` } } as never)).toBeNull();
    expect(
      getSessionId({ headers: { cookie: `${SESSION_COOKIE}=${"z".repeat(64)}` } } as never),
    ).toBeNull();
    expect(
      getSessionId({ headers: { cookie: `${SESSION_COOKIE}=` } } as never),
    ).toBeNull();
  });
});

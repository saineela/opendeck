import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../db.js";
import {
  apiSignature,
  deleteLastFmSession,
  loadLastFmSession,
  saveLastFmSession,
} from "./lastfm.js";

function md5(value: string): string {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

describe("apiSignature", () => {
  it("matches the Last.fm md5(api_key+method+...sorted+secret) scheme", () => {
    // Canonical formula: sorted keys, key then value, secret appended last.
    const expected = md5("api_keyAPIKEYmethodauth.getTokenSECRET");
    expect(apiSignature({ method: "auth.getToken", api_key: "APIKEY" }, "SECRET")).toBe(expected);
  });

  it("is independent of parameter insertion order", () => {
    const a = apiSignature({ artist: "A", track: "T", album: "L" }, "S");
    const b = apiSignature({ album: "L", track: "T", artist: "A" }, "S");
    expect(a).toBe(b);
    expect(a).toBe(md5("albumLartistAtrackTS"));
  });

  it("produces a 32-char hex digest", () => {
    expect(apiSignature({ method: "track.scrobble" }, "secret")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when the shared secret changes", () => {
    const params = { method: "auth.getSession", token: "tok" };
    expect(apiSignature(params, "secret1")).not.toBe(apiSignature(params, "secret2"));
  });
});

describe("Last.fm session storage", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
    ).run("user-1", "sub-1", "Test User", Date.now(), Date.now());
    db.prepare(
      "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
    ).run("user-2", "sub-2", "Other User", Date.now(), Date.now());
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips a session per user", () => {
    expect(loadLastFmSession(db, "user-1")).toBeNull();
    saveLastFmSession(db, "user-1", { username: "scrobbler", sessionKey: "key-1" });
    expect(loadLastFmSession(db, "user-1")).toEqual({
      username: "scrobbler",
      sessionKey: "key-1",
    });
    expect(loadLastFmSession(db, "user-2")).toBeNull();
  });

  it("upserts a replaced session", () => {
    saveLastFmSession(db, "user-1", { username: "old", sessionKey: "k1" });
    saveLastFmSession(db, "user-1", { username: "new", sessionKey: "k2" });
    expect(loadLastFmSession(db, "user-1")).toEqual({ username: "new", sessionKey: "k2" });
  });

  it("deletes a disconnected session", () => {
    saveLastFmSession(db, "user-1", { username: "scrobbler", sessionKey: "key-1" });
    deleteLastFmSession(db, "user-1");
    expect(loadLastFmSession(db, "user-1")).toBeNull();
  });
});

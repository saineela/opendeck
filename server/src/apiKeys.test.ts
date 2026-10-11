import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE, createSession } from "./middleware/session.js";

/**
 * Per-account API keys.
 *
 * The properties that matter: the plaintext key is returned exactly once,
 * bearer auth resolves to the owning account, key management refuses a
 * bearer key (no self-minting), and revocation is immediate.
 */

interface Harness {
  db: Db;
  base: string;
  close: () => Promise<void>;
  cookieA: string;
  cookieB: string;
}

let harness: Harness;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "apikeys-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-keys-")),
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  insert.run(userA, "password", null, "Alice", "alice@example.com", now, now);
  insert.run(userB, "password", null, "Bob", "bob@example.com", now, now);

  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  harness = {
    db,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
      db.close();
    },
    cookieA: `${SESSION_COOKIE}=${createSession(db, userA)}`,
    cookieB: `${SESSION_COOKIE}=${createSession(db, userB)}`,
  };
});

afterEach(async () => {
  await harness.close();
});

function call(
  method: string,
  pathname: string,
  options: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${harness.base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function createKey(cookie: string, label = "test key"): Promise<string> {
  const res = await call("POST", "/api/keys", { cookie, body: { label } });
  expect(res.status).toBe(201);
  const payload = (await res.json()) as { key: string };
  return payload.key;
}

describe("POST /api/keys", () => {
  it("requires a browser session, not an API key", async () => {
    const key = await createKey(harness.cookieA);
    const res = await call("POST", "/api/keys", { bearer: key, body: { label: "sneaky" } });
    expect(res.status).toBe(401);
  });

  it("rejects a missing or oversized label", async () => {
    const blank = await call("POST", "/api/keys", { cookie: harness.cookieA, body: { label: " " } });
    expect(blank.status).toBe(400);
    const big = await call("POST", "/api/keys", {
      cookie: harness.cookieA,
      body: { label: "x".repeat(81) },
    });
    expect(big.status).toBe(400);
  });

  it("returns the plaintext key exactly once with a matching prefix", async () => {
    const res = await call("POST", "/api/keys", { cookie: harness.cookieA, body: { label: "cli" } });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      id: string;
      key: string;
      keyPrefix: string;
      label: string;
    };
    expect(payload.key).toMatch(/^odk_[A-Za-z0-9_-]{43}$/);
    expect(payload.keyPrefix).toBe(payload.key.slice(0, 12));
    expect(payload.label).toBe("cli");

    // The stored row keeps only the SHA-256 hash — never the plaintext.
    const row = harness.db
      .prepare("SELECT key_hash FROM api_keys WHERE id = ?")
      .get(payload.id) as { key_hash: string };
    const digest = crypto.createHash("sha256").update(payload.key).digest("hex");
    expect(row.key_hash).toBe(digest);
    expect(row.key_hash).not.toBe(payload.key);
  });
});

describe("GET /api/keys", () => {
  it("lists prefixes and timestamps but never a usable key", async () => {
    const created = await createKey(harness.cookieA, "laptop");
    const res = await call("GET", "/api/keys", { cookie: harness.cookieA });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      keys: Array<{ id: string; label: string; keyPrefix: string; createdAt: number }>;
    };
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0].label).toBe("laptop");
    expect(payload.keys[0].keyPrefix).toBe(created.slice(0, 12));
    expect(JSON.stringify(payload)).not.toContain(created);
  });

  it("scopes the list to the signed-in account", async () => {
    await createKey(harness.cookieA, "alice-key");
    const res = await call("GET", "/api/keys", { cookie: harness.cookieB });
    const payload = (await res.json()) as { keys: unknown[] };
    expect(payload.keys).toEqual([]);
  });

  it("requires a session", async () => {
    const res = await call("GET", "/api/keys");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/keys/:id", () => {
  it("revokes the key and immediately kills bearer auth", async () => {
    const created = await call("POST", "/api/keys", { cookie: harness.cookieA, body: { label: "victim" } });
    expect(created.status).toBe(201);
    const { id, key } = (await created.json()) as { id: string; key: string };

    // The key authenticates as its owning account on session routes.
    const who = await call("GET", "/api/auth/session", { bearer: key });
    expect((await who.json()) as { authenticated: boolean }).toMatchObject({
      authenticated: true,
      user: { email: "alice@example.com" },
    });
    const before = await call("GET", "/api/auth/totp/status", { bearer: key });
    expect(before.status).toBe(200);

    // A second key exists so revocation is exercised against a specific id,
    // not whichever row the list happens to return first.
    await createKey(harness.cookieA, "second");

    const del = await call("DELETE", `/api/keys/${id}`, { cookie: harness.cookieA });
    expect(del.status).toBe(200);

    const after = await call("GET", "/api/auth/totp/status", { bearer: key });
    expect(after.status).toBe(401);
  });

  it("does not let one account revoke another account's key", async () => {
    await createKey(harness.cookieA, "keep-me");
    const listA = await call("GET", "/api/keys", { cookie: harness.cookieA });
    const { keys } = (await listA.json()) as { keys: Array<{ id: string }> };

    const del = await call("DELETE", `/api/keys/${keys[0].id}`, { cookie: harness.cookieB });
    expect(del.status).toBe(404);

    const key = await createKey(harness.cookieA);
    const stillWorks = await call("GET", "/api/auth/totp/status", { bearer: key });
    expect(stillWorks.status).toBe(200);
  });

  it("404s for unknown ids", async () => {
    const res = await call("DELETE", `/api/keys/${crypto.randomUUID()}`, {
      cookie: harness.cookieA,
    });
    expect(res.status).toBe(404);
  });
});

describe("bearer authentication", () => {
  it("rejects a garbage or non-existent key", async () => {
    for (const bad of ["odk_not-a-real-key", "nonsense", ""]) {
      const res = await call("GET", "/api/auth/totp/status", { bearer: bad });
      expect(res.status, bad).toBe(401);
    }
  });

  it("does not resolve a session cookie presented as a bearer token", async () => {
    const sessionId = harness.cookieA.split("=")[1];
    const res = await call("GET", "/api/auth/totp/status", { bearer: sessionId });
    expect(res.status).toBe(401);
  });
});

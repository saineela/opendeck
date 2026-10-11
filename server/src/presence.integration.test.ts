import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE } from "./middleware/session.js";

/**
 * Discord Rich Presence (`/api/presence/*`).
 *
 * Properties that matter: every route refuses anonymous callers; the switch
 * is per account and durable; turning it off clears what is already on the
 * profile; a user who never opted in never causes a report; the user-authored
 * status line is bounded so it cannot blow past Discord's field limits; and
 * an API-key play is attributed to the key's owner (the shared middleware
 * resolves the user, which is what lets `/api/media/stream` report too).
 */

const GOOD_PASSWORD = "correct horse battery";

// The bridge is a process-wide singleton that would try real sockets. Spy on
// its module surface so tests assert *intent* (what we asked Discord to show)
// without touching the network. vi.mock is hoisted above imports.
vi.mock("./services/discordRpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/discordRpc.js")>();
  return {
    ...actual,
    updatePresence: vi.fn(async () => undefined),
    clearPresence: vi.fn(async () => undefined),
  };
});

const { updatePresence, clearPresence } = await import("./services/discordRpc.js");

interface Ctx {
  db: Db;
  base: string;
  userAId: string;
  userBId: string;
  cookieA: string;
  cookieB: string;
  close: () => Promise<void>;
}

async function withApp(use: (ctx: Ctx) => Promise<void>): Promise<void> {
  const config: ServerConfig = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "presence-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-presence-")),
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, password_hash,
                        totp_secret, totp_enabled, totp_backup_codes, failed_logins, locked_until,
                        role, created_at, last_login_at)
     VALUES (?, 'password', NULL, ?, ?, NULL, ?, NULL, 0, '[]', 0, NULL, 'user', ?, ?)`,
  );
  const userAId = crypto.randomUUID();
  const userBId = crypto.randomUUID();
  // hashPassword is slow by design; reuse one hash for both accounts.
  const { hashPassword } = await import("./services/password.js");
  const hash = await hashPassword(GOOD_PASSWORD);
  insert.run(userAId, "Alice", "alice@example.com", hash, now, now);
  insert.run(userBId, "Bob", "bob@example.com", hash, now, now);

  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: GOOD_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    return `${SESSION_COOKIE}=${raw.split(";")[0].slice(SESSION_COOKIE.length + 1)}`;
  };

  try {
    await use({
      db,
      base,
      userAId,
      userBId,
      cookieA: await login("alice@example.com"),
      cookieB: await login("bob@example.com"),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
  } finally {
    vi.mocked(updatePresence).mockClear();
    vi.mocked(clearPresence).mockClear();
    server.close();
  }
}

function json(url: string, init: RequestInit & { cookie?: string }): Promise<Response> {
  const { cookie, headers, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
    },
  });
}

afterEach(() => {
  vi.mocked(updatePresence).mockClear();
  vi.mocked(clearPresence).mockClear();
});

describe("presence routes: access control", () => {
  it("refuses anonymous callers on every route", async () => {
    await withApp(async ({ base }) => {
      for (const [method, route] of [
        ["GET", "/api/presence/status"],
        ["GET", "/api/presence/settings"],
        ["PUT", "/api/presence/settings"],
        ["POST", "/api/presence/now-playing"],
        ["POST", "/api/presence/clear"],
      ] as const) {
        const res = await json(`${base}${route}`, {
          method,
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect(res.status, `${method} ${route}`).toBe(401);
      }
    });
  });
});

describe("presence settings", () => {
  it("defaults to off and round-trips an edit durably", async () => {
    await withApp(async ({ base, cookieA, db, userAId }) => {
      const initial = await json(`${base}/api/presence/settings`, { method: "GET", cookie: cookieA });
      expect(initial.status).toBe(200);
      const initialBody = (await initial.json()) as { settings: { enabled: boolean; customMessage: string } };
      expect(initialBody.settings).toEqual({ enabled: false, customMessage: "", showPlatform: true });

      const saved = await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true, customMessage: "Coding OpenDeck", showPlatform: false }),
      });
      expect(saved.status).toBe(200);

      // Durable: straight from the database, not just an echo.
      const row = db
        .prepare("SELECT value FROM app_settings WHERE user_id = ? AND key = 'discordPresence'")
        .get(userAId) as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ enabled: true, customMessage: "Coding OpenDeck" });
    });
  });

  it("is per account — one user's switch never leaks to another", async () => {
    await withApp(async ({ base, cookieA, cookieB }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true, customMessage: "Alice is here" }),
      });

      const other = await json(`${base}/api/presence/settings`, { method: "GET", cookie: cookieB });
      const body = (await other.json()) as { settings: { enabled: boolean; customMessage: string } };
      expect(body.settings.enabled).toBe(false);
      expect(body.settings.customMessage).toBe("");
    });
  });

  it("truncates an oversized status line instead of storing it whole", async () => {
    await withApp(async ({ base, cookieA }) => {
      const res = await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ customMessage: "x".repeat(1000) }),
      });
      const body = (await res.json()) as { settings: { customMessage: string } };
      expect(body.settings.customMessage.length).toBeLessThanOrEqual(128);
    });
  });

  it("clears the profile when the switch is turned off", async () => {
    await withApp(async ({ base, cookieA }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });
      vi.mocked(clearPresence).mockClear();

      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: false }),
      });
      expect(vi.mocked(clearPresence)).toHaveBeenCalledTimes(1);
    });
  });
});

describe("now-playing reports", () => {
  it("never reports for an account that has presence off", async () => {
    await withApp(async ({ base, cookieA }) => {
      const res = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "Counting Stars", artist: "OneRepublic" }),
      });
      const body = (await res.json()) as { accepted: boolean; reason?: string };
      expect(body.accepted).toBe(false);
      expect(body.reason).toBe("disabled");
      expect(vi.mocked(updatePresence)).not.toHaveBeenCalled();
    });
  });

  it("reports a valid track once the account opted in", async () => {
    await withApp(async ({ base, cookieA }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });

      const res = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({
          title: "Counting Stars",
          artist: "OneRepublic",
          artworkUrl: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
          duration: 257,
          currentTime: 12,
          isPlaying: true,
        }),
      });
      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
      expect(vi.mocked(updatePresence)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updatePresence)).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Counting Stars", artist: "OneRepublic" }),
      );
    });
  });

  it("rejects a report with no title and drops non-https artwork", async () => {
    await withApp(async ({ base, cookieA }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });

      const noTitle = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ artist: "Nobody" }),
      });
      expect(((await noTitle.json()) as { reason: string }).reason).toBe("no-title");

      const insecure = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "Track", artworkUrl: "http://evil.example/art.jpg" }),
      });
      expect(((await insecure.json()) as { accepted: boolean }).accepted).toBe(true);
      const payload = vi.mocked(updatePresence).mock.calls.at(-1)![0];
      expect(payload.artworkUrl).toBeUndefined();
    });
  });

  it("ignores nonsense fields without failing the request", async () => {
    await withApp(async ({ base, cookieA }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });

      const res = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "Track", currentTime: -5, duration: "long", isPlaying: "yes" }),
      });
      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);
      const payload = vi.mocked(updatePresence).mock.calls.at(-1)![0];
      expect(payload.currentTime).toBeUndefined();
      expect(payload.duration).toBeUndefined();
      expect(payload.isPlaying).toBe(true);
    });
  });
});

describe("Secret Show", () => {
  it("refuses anonymous callers on every route", async () => {
    await withApp(async ({ base }) => {
      for (const [method, route] of [
        ["GET", "/api/presence/secret-show"],
        ["POST", "/api/presence/secret-show"],
        ["DELETE", "/api/presence/secret-show/abc"],
      ] as const) {
        const res = await json(`${base}${route}`, {
          method,
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect(res.status, `${method} ${route}`).toBe(401);
      }
    });
  });

  it("adds, lists, dedupes, and removes a hidden song", async () => {
    await withApp(async ({ base, cookieA }) => {
      const add = await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ videoId: "vid-abc123", title: "Secret Song", artist: "Nobody" }),
      });
      expect(((await add.json()) as { added: boolean }).added).toBe(true);

      // Idempotent: the same video twice is one entry.
      const again = await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ videoId: "vid-abc123" }),
      });
      const againBody = (await again.json()) as { added: boolean; tracks: unknown[] };
      expect(againBody.added).toBe(false);
      expect(againBody.tracks).toHaveLength(1);

      const list = await json(`${base}/api/presence/secret-show`, { method: "GET", cookie: cookieA });
      const listBody = (await list.json()) as { tracks: Array<{ videoId: string; title: string }> };
      expect(listBody.tracks[0]).toMatchObject({ videoId: "vid-abc123", title: "Secret Song" });

      const remove = await json(`${base}/api/presence/secret-show/vid-abc123`, {
        method: "DELETE",
        cookie: cookieA,
        body: "{}",
      });
      expect(((await remove.json()) as { tracks: unknown[] }).tracks).toHaveLength(0);
    });
  });

  it("rejects an add without a videoId", async () => {
    await withApp(async ({ base, cookieA }) => {
      const res = await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "No id" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("suppresses Discord for a hidden song — the profile shows nothing playing", async () => {
    await withApp(async ({ base, cookieA }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });
      await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ videoId: "vid-secret" }),
      });
      vi.mocked(updatePresence).mockClear();
      vi.mocked(clearPresence).mockClear();

      // The hidden song: rejected, and anything already showing is cleared.
      const hidden = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "Secret Song", videoId: "vid-secret" }),
      });
      const hiddenBody = (await hidden.json()) as { accepted: boolean; reason: string };
      expect(hiddenBody.accepted).toBe(false);
      expect(hiddenBody.reason).toBe("secret-show");
      expect(vi.mocked(updatePresence)).not.toHaveBeenCalled();
      expect(vi.mocked(clearPresence)).toHaveBeenCalledTimes(1);

      // A normal song right after reports fine — the exception is per-track.
      const normal = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ title: "Public Song", videoId: "vid-public" }),
      });
      expect(((await normal.json()) as { accepted: boolean }).accepted).toBe(true);
      expect(vi.mocked(updatePresence)).toHaveBeenCalledTimes(1);
    });
  });

  it("is per account — one user's exceptions never silence another", async () => {
    await withApp(async ({ base, cookieA, cookieB }) => {
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieA,
        body: JSON.stringify({ enabled: true }),
      });
      await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ videoId: "vid-mine" }),
      });

      // Bob has presence on and no exceptions; Alice's list must not affect him.
      await json(`${base}/api/presence/settings`, {
        method: "PUT",
        cookie: cookieB,
        body: JSON.stringify({ enabled: true }),
      });
      vi.mocked(updatePresence).mockClear();
      const res = await json(`${base}/api/presence/now-playing`, {
        method: "POST",
        cookie: cookieB,
        body: JSON.stringify({ title: "Same Song", videoId: "vid-mine" }),
      });
      expect(((await res.json()) as { accepted: boolean }).accepted).toBe(true);
      expect(vi.mocked(updatePresence)).toHaveBeenCalledTimes(1);
    });
  });

  it("does not leak the exception list across accounts", async () => {
    await withApp(async ({ base, cookieA, cookieB }) => {
      await json(`${base}/api/presence/secret-show`, {
        method: "POST",
        cookie: cookieA,
        body: JSON.stringify({ videoId: "vid-private" }),
      });
      const other = await json(`${base}/api/presence/secret-show`, {
        method: "GET",
        cookie: cookieB,
      });
      expect(((await other.json()) as { tracks: unknown[] }).tracks).toHaveLength(0);
    });
  });
});

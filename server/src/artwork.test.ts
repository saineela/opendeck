import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE } from "./middleware/session.js";
import { hashImageUrl, storeCachedImage } from "./services/imageCache.js";
import { hashPassword } from "./services/password.js";

/**
 * `GET /api/artwork` and the artwork-cache administration around it.
 *
 * Properties that matter: the route serves bytes it already has without ever
 * touching the origin, it answers 304 to a matching validator, it refuses
 * anything that is not an allowlisted https artwork host (it is an
 * unauthenticated endpoint), and the budget/format controls are admin-only
 * because the cache is shared by every account.
 *
 * The origin-fetch path is deliberately not exercised here: every host on the
 * artwork allowlist is a real Google property, so a cache-miss test would
 * depend on the public internet. The validation, serving, and access-control
 * paths are all reachable without it.
 */

const GOOD_PASSWORD = "correct horse battery";
const ART_URL = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";

interface Ctx {
  db: Db;
  base: string;
  adminCookie: string;
  userCookie: string;
  close: () => Promise<void>;
}

async function withApp(use: (ctx: Ctx) => Promise<void>): Promise<void> {
  const config: ServerConfig = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "artwork-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-artwork-")),
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, password_hash,
                        totp_secret, totp_enabled, totp_backup_codes, failed_logins, locked_until,
                        role, created_at, last_login_at)
     VALUES (?, 'password', NULL, ?, ?, NULL, ?, NULL, 0, '[]', 0, NULL, ?, ?, ?)`,
  );
  const adminHash = await hashPassword(GOOD_PASSWORD);
  const userHash = await hashPassword(GOOD_PASSWORD);
  insert.run(crypto.randomUUID(), "Ada Admin", "ada@example.com", adminHash, "admin", now, now);
  insert.run(crypto.randomUUID(), "Uzi User", "user@example.com", userHash, "user", now, now);

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
      adminCookie: await login("ada@example.com"),
      userCookie: await login("user@example.com"),
      close: async () => {
        server.close();
        await once(server, "close");
        db.close();
      },
    });
  } finally {
    server.close();
    db.close();
  }
}

function call(
  ctx: Ctx,
  method: string,
  pathname: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${ctx.base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function artwork(ctx: Ctx, url = ART_URL, headers?: Record<string, string>): Promise<Response> {
  return call(ctx, "GET", `/api/artwork?url=${encodeURIComponent(url)}`, { headers });
}

describe("GET /api/artwork", () => {
  it("serves a cached picture with a validator and a long-lived cache header", async () => {
    await withApp(async (ctx) => {
      const payload = Uint8Array.from({ length: 128 }, (_unused, i) => i % 251);
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", payload);

      const res = await artwork(ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("content-length")).toBe("128");
      expect(res.headers.get("cache-control")).toBe("public, max-age=2592000, immutable");
      expect(res.headers.get("etag")).toBe(`"${hashImageUrl(ART_URL)}"`);
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(payload));
    });
  });

  it("answers 304 to a matching If-None-Match without sending the body", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from([1, 2, 3]));
      const first = await artwork(ctx);
      const etag = first.headers.get("etag")!;
      await first.arrayBuffer();

      const second = await artwork(ctx, ART_URL, { "if-none-match": etag });
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });
  });

  it("derives the validator from the raw query string, not the normalized URL", async () => {
    // `new URL()` collapses `/./`, so a miss (which fetches by parsed URL) and
    // a hit (which reads by raw key) would mint different ETags if the
    // validator came from the normalized form. Then If-None-Match would never
    // match and the 304 path would be dead for any non-normalized URL.
    const raw = "https://i.ytimg.com/vi/dQw4w9WgXcQ/./hqdefault.jpg";
    expect(new URL(raw).toString()).not.toBe(raw);

    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, raw, "image/jpeg", Uint8Array.from([1, 2, 3]));
      const res = await artwork(ctx, raw);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe(`"${hashImageUrl(raw)}"`);
      expect(res.headers.get("etag")).not.toBe(`"${hashImageUrl(new URL(raw).toString())}"`);
    });
  });

  it("mints the same validator on a cold miss as on the warm hit", async () => {
    // The regression this guards: the miss path fetches by *parsed* URL, so an
    // ETag taken from that URL would differ from the one the hit path derives
    // from the cache key, and revalidation would silently never match.
    // `fetch` is stubbed because every host on the artwork allowlist is a real
    // Google property — the point is the two paths agreeing, not the network.
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/./hqdefault.jpg";
    const payload = Uint8Array.from({ length: 16 }, (_unused, index) => index);

    await withApp(async (ctx) => {
      const realFetch = globalThis.fetch;
      // Only synthesize the *origin* answer; anything aimed at the test server
      // must still go through the real HTTP stack.
      globalThis.fetch = (async (
        input: Parameters<typeof realFetch>[0],
        init?: Parameters<typeof realFetch>[1],
      ) => {
        const href =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : String(input);
        if (href.startsWith(ctx.base)) return realFetch(input, init);
        return new Response(payload, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }) as typeof fetch;
      try {
        const miss = await artwork(ctx, url);
        expect(miss.status).toBe(200);
        expect(miss.headers.get("content-type")).toBe("image/png");
        const missEtag = miss.headers.get("etag")!;
        expect(missEtag).toBe(`"${hashImageUrl(url)}"`);
        await miss.arrayBuffer();

        // Warm read now revalidates against the very validator the miss issued.
        const warm = await artwork(ctx, url, { "if-none-match": missEtag });
        expect(warm.status).toBe(304);
        expect(warm.headers.get("etag")).toBe(missEtag);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("ignores a stale validator and returns the full picture", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from([1, 2, 3]));
      const res = await artwork(ctx, ART_URL, { "if-none-match": '"not-the-right-hash"' });
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(3);
    });
  });

  it("requires an absolute URL", async () => {
    await withApp(async (ctx) => {
      expect((await call(ctx, "GET", "/api/artwork")).status).toBe(400);
      expect((await call(ctx, "GET", "/api/artwork?url=not-a-url")).status).toBe(400);
      expect((await call(ctx, "GET", "/api/artwork?url=/relative.jpg")).status).toBe(400);
    });
  });

  it("refuses anything outside the artwork host allowlist", async () => {
    await withApp(async (ctx) => {
      // Right shape, wrong host — the general proxy allowlist is broader, but
      // this endpoint must not become an open relay for it.
      expect((await artwork(ctx, "https://example.com/cover.jpg")).status).toBe(403);
      // An allowlisted parent host that is not an artwork origin.
      expect((await artwork(ctx, "https://www.youtube.com/favicon.ico")).status).toBe(403);
      // Non-https is refused before the host check.
      expect((await artwork(ctx, "http://i.ytimg.com/x.jpg")).status).toBe(403);
      expect((await artwork(ctx, "file:///etc/passwd")).status).toBe(403);
      // A lookalike suffix must not pass the endsWith test.
      expect((await artwork(ctx, "https://evilytimg.com/x.jpg")).status).toBe(403);
    });
  });
});

describe("artwork cache settings", () => {
  it("shows usage to any signed-in account but refuses anonymous callers", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from([1, 2, 3]));
      expect((await call(ctx, "POST", "/api/cache/artwork/stats", { body: {} })).status).toBe(401);

      const res = await call(ctx, "POST", "/api/cache/artwork/stats", {
        cookie: ctx.userCookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { entryCount: number }).entryCount).toBe(1);
    });
  });

  it("keeps the budget and the format admin-only", async () => {
    await withApp(async (ctx) => {
      const anonymous = await call(ctx, "POST", "/api/cache/artwork/setMaxBytes", {
        body: { maxBytes: 1024 },
      });
      expect(anonymous.status).toBe(401);

      const asUser = await call(ctx, "POST", "/api/cache/artwork/setMaxBytes", {
        cookie: ctx.userCookie,
        body: { maxBytes: 1024 },
      });
      expect(asUser.status).toBe(403);

      const asAdmin = await call(ctx, "POST", "/api/cache/artwork/setMaxBytes", {
        cookie: ctx.adminCookie,
        body: { maxBytes: 1024 },
      });
      expect(asAdmin.status).toBe(200);
      // 1 KB is below the floor; the server clamps rather than truncating.
      expect(((await asAdmin.json()) as { maxBytes: number }).maxBytes).toBe(64 * 1024 * 1024);

      const bad = await call(ctx, "POST", "/api/cache/artwork/setMaxBytes", {
        cookie: ctx.adminCookie,
        body: { maxBytes: -5 },
      });
      expect(bad.status).toBe(400);
    });
  });

  it("formats the cache for an admin and refuses everyone else", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from([1, 2, 3]));
      expect(
        (await call(ctx, "POST", "/api/cache/artwork/format", { cookie: ctx.userCookie, body: {} }))
          .status,
      ).toBe(403);

      const res = await call(ctx, "POST", "/api/cache/artwork/format", {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { entryCount: number }).entryCount).toBe(0);
      const remaining = ctx.db.prepare("SELECT COUNT(*) AS n FROM image_cache").get() as {
        n: number;
      };
      expect(remaining.n).toBe(0);
    });
  });
});

describe("admin image-cache report", () => {
  it("refuses anonymous callers and non-admins", async () => {
    await withApp(async (ctx) => {
      expect((await call(ctx, "GET", "/api/admin/image-cache")).status).toBe(401);
      expect(
        (await call(ctx, "GET", "/api/admin/image-cache", { cookie: ctx.userCookie })).status,
      ).toBe(403);
    });
  });

  it("lists the biggest pictures with their play counts", async () => {
    await withApp(async (ctx) => {
      const other = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from({ length: 400 }, () => 7));
      storeCachedImage(ctx.db, other, "image/jpeg", Uint8Array.from({ length: 100 }, () => 7));

      const res = await call(ctx, "GET", "/api/admin/image-cache", { cookie: ctx.adminCookie });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        stats: { usedBytes: number; entryCount: number };
        images: Array<{ url: string; bytes: number; playCount: number }>;
      };
      expect(payload.stats).toMatchObject({ usedBytes: 500, entryCount: 2 });
      expect(payload.images.map((image) => image.url)).toEqual([ART_URL, other]);
      expect(payload.images.every((image) => image.playCount === 0)).toBe(true);
    });
  });

  it("formats from the admin panel and empties the cache", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from([1, 2, 3]));
      const res = await call(ctx, "POST", "/api/admin/image-cache/format", {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { stats: { entryCount: number } }).stats.entryCount).toBe(0);
    });
  });

  it("reports artwork bytes in the instance overview", async () => {
    await withApp(async (ctx) => {
      storeCachedImage(ctx.db, ART_URL, "image/jpeg", Uint8Array.from({ length: 64 }, () => 1));
      const overview = await call(ctx, "GET", "/api/admin/overview", { cookie: ctx.adminCookie });
      expect(((await overview.json()) as { imageCacheBytes: number }).imageCacheBytes).toBe(64);
    });
  });
});

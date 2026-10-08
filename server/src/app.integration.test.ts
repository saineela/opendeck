import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, importJWK } from "jose";
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE, createSession } from "./middleware/session.js";
import { resetDiscoveryCache } from "./services/googleOAuth.js";
import { resetYouTubeClientIdentityCache } from "./services/youtubeOAuth.js";

const APP_URL = "http://localhost:4000";
const GOOGLE_CLIENT_ID = "test-client-id";

function testConfig(overrides: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "integration-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "jamac-it-")),
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...overrides,
  });
}

interface Running {
  base: string;
  close: () => Promise<void>;
}

async function startApp(config: ServerConfig, db: Db): Promise<Running> {
  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function seedUser(db: Db, userId: string, name = "Test User"): void {
  db.prepare(
    "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  ).run(userId, `sub-${userId}`, name, `${userId}@example.com`, Date.now(), Date.now());
}

function cookieFrom(setCookies: string[], name: string): string | null {
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1));
    }
  }
  return null;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Condition not met before timeout.");
}

interface FakeGoogle {
  origin: string;
  discoveryUrl: string;
  expectedChallenge: string | null;
  tokenRequests: Array<Record<string, string>>;
  close: () => Promise<void>;
}

/**
 * A minimal OpenID provider: discovery, JWKS, and a token endpoint that
 * enforces PKCE (sha256(code_verifier) must equal the code_challenge from the
 * authorize redirect) before signing an RS256 id_token.
 */
async function startFakeGoogle(): Promise<FakeGoogle> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "test-key" };
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    use: "sig",
    kid: "test-key",
  };

  const fake: FakeGoogle = {
    origin: "",
    discoveryUrl: "",
    expectedChallenge: null,
    tokenRequests: [],
    close: async () => {},
  };

  const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://fake.google.invalid").pathname;

      if (pathname === "/.well-known/openid-configuration") {
        sendJson(res, 200, {
          issuer: fake.origin,
          authorization_endpoint: `${fake.origin}/authorize`,
          token_endpoint: `${fake.origin}/token`,
          jwks_uri: `${fake.origin}/jwks`,
        });
        return;
      }

      if (pathname === "/jwks") {
        sendJson(res, 200, { keys: [publicJwk] });
        return;
      }

      if (pathname === "/token") {
        const params = new URLSearchParams(await readBody(req));
        fake.tokenRequests.push(Object.fromEntries(params));

        if (params.get("grant_type") !== "authorization_code") {
          sendJson(res, 400, { error: "unsupported_grant_type" });
          return;
        }
        if (params.get("client_id") !== GOOGLE_CLIENT_ID) {
          sendJson(res, 400, { error: "invalid_client" });
          return;
        }
        if (params.get("redirect_uri") !== `${APP_URL}/api/auth/google/callback`) {
          sendJson(res, 400, { error: "invalid_redirect_uri" });
          return;
        }
        const verifier = params.get("code_verifier") ?? "";
        const derived = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (!fake.expectedChallenge || derived !== fake.expectedChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE failed" });
          return;
        }

        const signingKey = await importJWK(
          privateJwk as Parameters<typeof importJWK>[0],
          "RS256",
        );
        const idToken = await new SignJWT({
          name: "Test User",
          email: "test@example.com",
          picture: "https://example.com/avatar.png",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setSubject("google-sub-123")
          .setIssuer(fake.origin)
          .setAudience(GOOGLE_CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(signingKey);

        sendJson(res, 200, {
          access_token: "ya29.test-access",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    })().catch((error) => {
      sendJson(res, 500, { error: String(error) });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.discoveryUrl = `${fake.origin}/.well-known/openid-configuration`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

describe("server integration", () => {
  let db: Db;
  let fake: FakeGoogle;
  let config: ServerConfig;
  let running: Running;

  beforeAll(async () => {
    fake = await startFakeGoogle();
    config = testConfig({ GOOGLE_OPENID_DISCOVERY: fake.discoveryUrl });
    db = openDatabase(":memory:");
    running = await startApp(config, db);
  });

  afterAll(async () => {
    await running.close();
    db.close();
    await fake.close();
  });

  beforeEach(() => {
    resetDiscoveryCache();
    resetYouTubeClientIdentityCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves health with hardened security headers", async () => {
    const res = await fetch(`${running.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.0.0" });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  describe("CSRF origin check", () => {
    it("rejects mutations from a foreign origin", async () => {
      const res = await fetch(`${running.base}/api/cache/stats`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Cross-site request rejected." });
    });

    it("rejects requests the browser labels cross-site", async () => {
      const res = await fetch(`${running.base}/api/cache/stats`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects malformed Origin headers", async () => {
      const res = await fetch(`${running.base}/api/cache/stats`, {
        method: "POST",
        headers: { origin: "not a url" },
      });
      expect(res.status).toBe(403);
    });

    it("allows same-origin mutations", async () => {
      const res = await fetch(`${running.base}/api/cache/stats`, {
        method: "POST",
        headers: { origin: running.base },
      });
      expect(res.status).toBe(200);
    });

    it("leaves GET requests alone", async () => {
      const res = await fetch(`${running.base}/api/auth/session`);
      expect(res.status).toBe(200);
    });
  });

  describe("unauthenticated session state", () => {
    it("reports signed-out state", async () => {
      const res = await fetch(`${running.base}/api/auth/session`);
      expect(await res.json()).toEqual({
        authenticated: false,
        user: null,
        youtubeLinked: false,
      });
    });

    it("rejects /whoami without a session", async () => {
      const res = await fetch(`${running.base}/api/auth/whoami`);
      expect(res.status).toBe(401);
    });
  });

  describe("Google sign-in", () => {
    it("completes the authorization-code + PKCE flow and creates a session", async () => {
      const start = await fetch(
        `${running.base}/api/auth/google/start?returnTo=%2Fsettings`,
        { redirect: "manual" },
      );
      expect(start.status).toBe(302);

      const authorize = new URL(start.headers.get("location")!);
      expect(authorize.origin).toBe(fake.origin);
      expect(authorize.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
      expect(authorize.searchParams.get("response_type")).toBe("code");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("scope")).toContain("openid");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${APP_URL}/api/auth/google/callback`,
      );
      const stateParam = authorize.searchParams.get("state");
      expect(stateParam).toBeTruthy();
      fake.expectedChallenge = authorize.searchParams.get("code_challenge");

      const setCookies = start.headers.getSetCookie();
      const oauthCookie = cookieFrom(setCookies, "jamac_oauth");
      expect(oauthCookie).toBeTruthy();
      const oauthRaw = setCookies.find((raw) => raw.startsWith("jamac_oauth=")) ?? "";
      expect(oauthRaw).toContain("HttpOnly");
      expect(oauthRaw).toContain("SameSite=Lax");

      const callback = await fetch(
        `${running.base}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(stateParam!)}`,
        { headers: { cookie: `jamac_oauth=${oauthCookie}` }, redirect: "manual" },
      );
      expect(callback.status).toBe(200);
      const html = await callback.text();
      expect(html).toContain("auth-callback.js");
      expect(html).not.toContain('id="auth-error">');

      // PKCE proof: the fake provider only issues an id_token when the
      // verifier hashes back to the challenge from the authorize redirect.
      expect(fake.tokenRequests).toHaveLength(1);
      expect(fake.tokenRequests[0].code).toBe("fake-code");
      expect(fake.tokenRequests[0].code_verifier).toBeTruthy();

      const sidCookies = callback.headers.getSetCookie();
      const sid = cookieFrom(sidCookies, SESSION_COOKIE);
      expect(sid).toMatch(/^[a-f0-9]{64}$/);
      const sidRaw = sidCookies.find((raw) => raw.startsWith(`${SESSION_COOKIE}=`)) ?? "";
      expect(sidRaw).toContain("HttpOnly");
      expect(sidRaw).toContain("SameSite=Lax");

      const sessionRes = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(await sessionRes.json()).toEqual({
        authenticated: true,
        user: {
          name: "Test User",
          email: "test@example.com",
          picture: "https://example.com/avatar.png",
        },
        youtubeLinked: false,
      });

      // The session persists across subsequent requests (browser refresh).
      const again = await fetch(`${running.base}/api/auth/whoami`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(again.status).toBe(200);

      // Logout destroys the session server-side.
      const logout = await fetch(`${running.base}/api/auth/logout`, {
        method: "POST",
        headers: { origin: running.base, cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(logout.status).toBe(200);
      const after = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false);
      const whoami = await fetch(`${running.base}/api/auth/whoami`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(whoami.status).toBe(401);
    });

    it("serves the popup callback helper script", async () => {
      const res = await fetch(`${running.base}/api/auth/auth-callback.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toContain("postMessage");
    });

    it("fails the callback without an OAuth cookie", async () => {
      const res = await fetch(
        `${running.base}/api/auth/google/callback?code=x&state=y`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Sign-in session expired");
    });

    it("fails the callback on a state mismatch", async () => {
      const start = await fetch(`${running.base}/api/auth/google/start`, {
        redirect: "manual",
      });
      expect(start.status).toBe(302);
      const oauthCookie = cookieFrom(start.headers.getSetCookie(), "jamac_oauth");
      const res = await fetch(
        `${running.base}/api/auth/google/callback?code=x&state=wrong-state`,
        { headers: { cookie: `jamac_oauth=${oauthCookie}` }, redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state mismatch");
    });

    it("fails the callback when the OAuth cookie is tampered with", async () => {
      const start = await fetch(`${running.base}/api/auth/google/start`, {
        redirect: "manual",
      });
      const oauthCookie = cookieFrom(start.headers.getSetCookie(), "jamac_oauth");
      const tampered = `${oauthCookie!.slice(0, -1)}${oauthCookie!.endsWith("a") ? "b" : "a"}`;
      const res = await fetch(
        `${running.base}/api/auth/google/callback?code=x&state=y`,
        { headers: { cookie: `jamac_oauth=${tampered}` }, redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("could not be verified");
    });
  });

  describe("settings", () => {
    it("requires a session for every operation", async () => {
      for (const route of ["get", "set", "remove", "clear"]) {
        const res = await fetch(`${running.base}/api/settings/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: running.base },
          body: JSON.stringify({ key: "volume", value: 1 }),
        });
        expect(res.status, route).toBe(401);
      }
    });

    it("round-trips JSON values for the signed-in user only", async () => {
      seedUser(db, "settings-user-a");
      seedUser(db, "settings-user-b", "Other User");
      const cookieA = `${SESSION_COOKIE}=${createSession(db, "settings-user-a")}`;
      const cookieB = `${SESSION_COOKIE}=${createSession(db, "settings-user-b")}`;
      const post = (cookie: string, route: string, body: unknown) =>
        fetch(`${running.base}/api/settings/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: running.base,
            cookie,
          },
          body: JSON.stringify(body),
        });

      const set = await post(cookieA, "set", {
        key: "player",
        value: { volume: 0.42, queue: ["a", "b"], nested: { shuffle: true } },
      });
      expect(await set.json()).toEqual({ ok: true });

      const get = await post(cookieA, "get", { key: "player" });
      expect(await get.json()).toEqual({
        value: { volume: 0.42, queue: ["a", "b"], nested: { shuffle: true } },
      });

      // Another signed-in user cannot read it.
      const other = await post(cookieB, "get", { key: "player" });
      expect(await other.json()).toEqual({ value: null });

      const missing = await post(cookieA, "get", { key: "does-not-exist" });
      expect(await missing.json()).toEqual({ value: null });

      const remove = await post(cookieA, "remove", { key: "player" });
      expect(await remove.json()).toEqual({ ok: true });
      const afterRemove = await post(cookieA, "get", { key: "player" });
      expect(await afterRemove.json()).toEqual({ value: null });

      const bad = await post(cookieA, "set", { key: "" });
      expect(bad.status).toBe(400);
    });
  });

  describe("cache", () => {
    it("round-trips values and reports stats", async () => {
      const post = (route: string, body: unknown) =>
        fetch(`${running.base}/api/cache/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: running.base },
          body: JSON.stringify(body),
        });

      const set = await post("set", { key: "it-recent", value: '["x","y"]' });
      expect(await set.json()).toEqual({ changed: true });
      const get = await post("get", { key: "it-recent" });
      expect(await get.json()).toEqual({ value: '["x","y"]' });
      const stats = await post("stats", {});
      const parsed = (await stats.json()) as { entryCount: number; maxBytes: number };
      expect(parsed.entryCount).toBeGreaterThanOrEqual(1);
      expect(parsed.maxBytes).toBeGreaterThan(0);

      const invalid = await post("get", {});
      expect(invalid.status).toBe(400);
      const invalidValue = await post("set", { key: "k", value: 42 });
      expect(invalidValue.status).toBe(400);

      const clear = await post("clear", {});
      expect(clear.status).toBe(200);
      const afterClear = await post("get", { key: "it-recent" });
      expect(await afterClear.json()).toEqual({ value: null });
    });

    it("requires a session to change the cache budget", async () => {
      const res = await fetch(`${running.base}/api/cache/setMaxBytes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxBytes: 1024 }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("YouTube proxy", () => {
    it("rejects non-allowlisted hosts", async () => {
      const res = await fetch(`${running.base}/api/yt/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: JSON.stringify({ url: "https://evil.example/steal", method: "GET" }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("evil.example");
    });

    it("rejects malformed payloads", async () => {
      const empty = await fetch(`${running.base}/api/yt/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);

      const badUrl = await fetch(`${running.base}/api/yt/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: JSON.stringify({ url: "definitely not a url" }),
      });
      expect(badUrl.status).toBe(400);
    });

    it("rejects unsupported methods without contacting upstream", async () => {
      const res = await fetch(`${running.base}/api/yt/proxy`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: JSON.stringify({ url: "https://www.youtube.com/", method: "PATCH" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("PATCH");
    });
  });

  describe("YouTube account link", () => {
    it("requires a session", async () => {
      const res = await fetch(`${running.base}/api/youtube/status`);
      expect(res.status).toBe(401);
    });

    it("reports idle for a user without a linked account", async () => {
      seedUser(db, "yt-status-user");
      const cookie = `${SESSION_COOKIE}=${createSession(db, "yt-status-user")}`;
      const res = await fetch(`${running.base}/api/youtube/status`, {
        headers: { cookie },
      });
      expect(await res.json()).toEqual({ state: "idle", linked: false });
    });
  });

  describe("device-code linking against a stubbed YouTube", () => {
    it("walks pending → linked, stores tokens encrypted, and unlinks", async () => {
      const calls = { tv: 0, script: 0, device: 0, token: 0, revoke: 0 };
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (!url.startsWith("https://www.youtube.com/")) return realFetch(input, init);

        if (url === "https://www.youtube.com/tv") {
          calls.tv += 1;
          return Promise.resolve(
            new Response(
              '<html><script id="base-js" src="/s/player/abc/base.js"></script></html>',
              { status: 200, headers: { "content-type": "text/html" } },
            ),
          );
        }
        if (url.startsWith("https://www.youtube.com/s/player/")) {
          calls.script += 1;
          return Promise.resolve(
            new Response(
              'var cfg={clientId:"TV_CLIENT_ID",clientSecret:"TV_CLIENT_SECRET"};',
              { status: 200, headers: { "content-type": "application/javascript" } },
            ),
          );
        }
        if (url === "https://www.youtube.com/o/oauth2/device/code") {
          calls.device += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                device_code: "device-code-1",
                user_code: "ABCD-EFGH",
                verification_url: "https://www.youtube.com/activate",
                expires_in: 1800,
                interval: 2,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url === "https://www.youtube.com/o/oauth2/token") {
          calls.token += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "yt-access-token",
                refresh_token: "yt-refresh-token",
                expires_in: 3600,
                scope: "https://www.googleapis.com/auth/youtube",
                token_type: "Bearer",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url.startsWith("https://www.youtube.com/o/oauth2/revoke")) {
          calls.revoke += 1;
          return Promise.resolve(
            new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
          );
        }
        return Promise.reject(new Error(`Unexpected YouTube URL: ${url}`));
      });

      try {
        seedUser(db, "yt-link-user");
        const cookie = `${SESSION_COOKIE}=${createSession(db, "yt-link-user")}`;
        const post = (route: string) =>
          fetch(`${running.base}/api/youtube/${route}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: running.base, cookie },
            body: "{}",
          });

        const link = await post("link");
        expect(link.status).toBe(200);
        const started = (await link.json()) as {
          state: string;
          userCode?: string;
          verificationUrl?: string;
          expiresInSec?: number;
        };
        expect(started.state).toBe("pending");
        expect(started.userCode).toBe("ABCD-EFGH");
        expect(started.verificationUrl).toContain("youtube.com/activate");
        expect(started.expiresInSec).toBeGreaterThan(0);

        // A second link request while pending is idempotent.
        const again = await post("link");
        expect(((await again.json()) as { state: string }).state).toBe("pending");
        expect(calls.device).toBe(1);

        // Polling completes once the (stubbed) user approves.
        await waitFor(async () => {
          const res = await fetch(`${running.base}/api/youtube/status`, {
            headers: { cookie },
          });
          const body = (await res.json()) as { state: string; linked: boolean };
          return body.state === "linked" && body.linked === true;
        }, 10_000);

        // Tokens live only in the database, encrypted at rest.
        const row = db
          .prepare("SELECT ciphertext, nonce, auth_tag FROM youtube_tokens WHERE user_id = ?")
          .get("yt-link-user") as
          | { ciphertext: string; nonce: string; auth_tag: string }
          | undefined;
        expect(row).toBeTruthy();
        expect(row!.ciphertext).not.toContain("yt-access-token");
        expect(row!.ciphertext).not.toContain("yt-refresh-token");

        // The status payload never leaks credentials to the client.
        const statusRes = await fetch(`${running.base}/api/youtube/status`, {
          headers: { cookie },
        });
        const statusText = await statusRes.text();
        expect(statusText).not.toContain("yt-access-token");
        expect(statusText).not.toContain("yt-refresh-token");

        // Unlink revokes remotely and clears local state.
        const unlink = await post("unlink");
        expect(await unlink.json()).toEqual({ state: "idle", linked: false });
        expect(calls.revoke).toBe(1);
        const idle = await fetch(`${running.base}/api/youtube/status`, {
          headers: { cookie },
        });
        expect(await idle.json()).toEqual({ state: "idle", linked: false });
      } finally {
        vi.unstubAllGlobals();
        resetYouTubeClientIdentityCache();
      }
    }, 20_000);
  });
});

describe("Google Sign-In configuration and rate limiting", () => {
  it("returns 503 when unconfigured and rate-limits start attempts", async () => {
    const config = testConfig({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    expect(config.google.configured).toBe(false);
    const db = openDatabase(":memory:");
    const running = await startApp(config, db);
    try {
      const first = await fetch(`${running.base}/api/auth/google/start`, {
        redirect: "manual",
      });
      expect(first.status).toBe(503);
      expect(((await first.json()) as { error: string }).error).toContain("GOOGLE_CLIENT_ID");

      let last: Response | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        last = await fetch(`${running.base}/api/auth/google/start`, {
          redirect: "manual",
        });
      }
      expect(last!.status).toBe(429);
      expect(last!.headers.get("retry-after")).toBeTruthy();
      expect(((await last!.json()) as { error: string }).error).toContain("slow down");
    } finally {
      await running.close();
      db.close();
    }
  });
});

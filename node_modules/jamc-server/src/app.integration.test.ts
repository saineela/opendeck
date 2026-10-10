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
import { recordPlay } from "./services/playHistory.js";
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

  describe("request body parsing", () => {
    it("returns 400 for malformed JSON", async () => {
      const res = await fetch(`${running.base}/api/cache/get`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON body." });
    });

    it("returns 413 for bodies over the JSON limit", async () => {
      const res = await fetch(`${running.base}/api/cache/set`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.base },
        body: JSON.stringify({ key: "huge", value: "x".repeat(11 * 1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large." });
    });
  });

  describe("unauthenticated session state", () => {
    it("reports signed-out state", async () => {
      const res = await fetch(`${running.base}/api/auth/session`);
      expect(await res.json()).toEqual({
        authenticated: false,
        user: null,
        youtubeLinked: false,
        totpEnabled: false,
        authProvider: null,
        passwordLoginEnabled: true,
        registrationEnabled: true,
        googleSignInEnabled: true,
        inviteCodeRequired: false,
        role: null,
        needsSetup: true,
        oauthProvider: { name: "Google", configured: true },
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
      const oauthCookie = cookieFrom(setCookies, "od_oauth");
      expect(oauthCookie).toBeTruthy();
      const oauthRaw = setCookies.find((raw) => raw.startsWith("od_oauth=")) ?? "";
      expect(oauthRaw).toContain("HttpOnly");
      expect(oauthRaw).toContain("SameSite=Lax");

      const callback = await fetch(
        `${running.base}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(stateParam!)}`,
        { headers: { cookie: `od_oauth=${oauthCookie}` }, redirect: "manual" },
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
        totpEnabled: false,
        authProvider: "google",
        passwordLoginEnabled: true,
        registrationEnabled: true,
        googleSignInEnabled: true,
        inviteCodeRequired: false,
        // First account on the instance → admin (first-run bootstrap).
        role: "admin",
        needsSetup: false,
        oauthProvider: { name: "Google", configured: true },
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
      const oauthCookie = cookieFrom(start.headers.getSetCookie(), "od_oauth");
      const res = await fetch(
        `${running.base}/api/auth/google/callback?code=x&state=wrong-state`,
        { headers: { cookie: `od_oauth=${oauthCookie}` }, redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state mismatch");
    });

    it("fails the callback when the OAuth cookie is tampered with", async () => {
      const start = await fetch(`${running.base}/api/auth/google/start`, {
        redirect: "manual",
      });
      const oauthCookie = cookieFrom(start.headers.getSetCookie(), "od_oauth");
      const tampered = `${oauthCookie!.slice(0, -1)}${oauthCookie!.endsWith("a") ? "b" : "a"}`;
      const res = await fetch(
        `${running.base}/api/auth/google/callback?code=x&state=y`,
        { headers: { cookie: `od_oauth=${tampered}` }, redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("could not be verified");
    });
  });

  describe("cross-device QR sign-in", () => {
    it("hands the consent to the phone and issues the session only to the verifying desktop", async () => {
      // 1. The desktop arms an attempt and renders its link as a QR code.
      const start = await fetch(`${running.base}/api/auth/google/qr/start`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: "{}",
      });
      expect(start.status).toBe(200);
      const { attemptId, qrUrl, expiresInSec } = (await start.json()) as {
        attemptId: string;
        qrUrl: string;
        expiresInSec: number;
      };
      expect(attemptId).toBeTruthy();
      expect(qrUrl).toContain(`/api/auth/google/qr/open?attempt=${attemptId}`);
      expect(expiresInSec).toBe(600);

      // 2. Verifying before the phone did anything reports pending.
      const early = await fetch(`${running.base}/api/auth/google/qr/verify`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      });
      expect(early.status).toBe(200);
      expect(await early.json()).toEqual({ status: "pending" });

      // 3. The phone scans the code: open → redirect to the provider.
      const open = await fetch(
        `${running.base}/api/auth/google/qr/open?attempt=${attemptId}`,
        { redirect: "manual" },
      );
      expect(open.status).toBe(302);
      const authorize = new URL(open.headers.get("location")!);
      expect(authorize.origin).toBe(fake.origin);
      const stateParam = authorize.searchParams.get("state");
      expect(stateParam).toBeTruthy();
      fake.expectedChallenge = authorize.searchParams.get("code_challenge");

      const openCookies = open.headers.getSetCookie();
      const oauthCookie = cookieFrom(openCookies, "od_oauth");
      const qrCookie = cookieFrom(openCookies, "od_qr_attempt");
      expect(oauthCookie).toBeTruthy();
      expect(qrCookie).toBe(attemptId);
      // The marker is path-scoped so it can never influence a non-QR callback.
      const qrRaw = openCookies.find((raw) => raw.startsWith("od_qr_attempt=")) ?? "";
      expect(qrRaw).toContain("Path=/api/auth");
      expect(qrRaw).toContain("HttpOnly");

      // 4. The phone finishes the consent at the callback: confirmation page,
      //    but NO session cookie — this browser is not the desktop.
      const callback = await fetch(
        `${running.base}/api/auth/google/callback?code=fake-qr-code&state=${encodeURIComponent(stateParam!)}`,
        {
          headers: { cookie: `od_oauth=${oauthCookie}; od_qr_attempt=${qrCookie}` },
          redirect: "manual",
        },
      );
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("Signed in on your computer");
      expect(cookieFrom(callback.headers.getSetCookie(), SESSION_COOKIE)).toBeNull();

      // 5. The desktop presses Verify: the session is minted for THIS client.
      const verify = await fetch(`${running.base}/api/auth/google/qr/verify`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      });
      expect(verify.status).toBe(200);
      const verified = (await verify.json()) as {
        status: string;
        user: { email: string | null };
      };
      expect(verified.status).toBe("verified");
      expect(verified.user.email).toBe("test@example.com");
      const sid = cookieFrom(verify.headers.getSetCookie(), SESSION_COOKIE);
      expect(sid).toMatch(/^[a-f0-9]{64}$/);

      const sessionRes = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(
        ((await sessionRes.json()) as { authenticated: boolean }).authenticated,
      ).toBe(true);

      // 6. Attempts are single-use: replaying Verify, rescanning the QR, and
      //    unknown ids are all refused.
      const replay = await fetch(`${running.base}/api/auth/google/qr/verify`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      });
      expect(replay.status).toBe(409);
      const rescanned = await fetch(
        `${running.base}/api/auth/google/qr/open?attempt=${attemptId}`,
        { redirect: "manual" },
      );
      expect(rescanned.status).toBe(404);
      const unknown = await fetch(`${running.base}/api/auth/google/qr/verify`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: JSON.stringify({ attemptId: "not-a-real-attempt" }),
      });
      expect(unknown.status).toBe(404);
      const missing = await fetch(`${running.base}/api/auth/google/qr/verify`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: "{}",
      });
      expect(missing.status).toBe(400);
    });
  });

  describe("play history and API key statistics", () => {
    it("records plays, serves history + stats per user, and reports per-key statistics", async () => {
      seedUser(db, "hist-user", "History User");
      const sid = createSession(db, "hist-user");
      const cookie = `${SESSION_COOKIE}=${sid}`;
      const jsonHeaders = { origin: running.base, "content-type": "application/json", cookie };

      // An API key to attribute plays to.
      const keyRes = await fetch(`${running.base}/api/keys`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ label: "Stereo" }),
      });
      expect(keyRes.status).toBe(201);
      const key = (await keyRes.json()) as { id: string };

      // The stream endpoint records: app plays, API-key plays, and dedupes
      // repeated ranged requests of the same track.
      const now = Date.now();
      expect(
        recordPlay(db, {
          userId: "hist-user",
          videoId: "vid-1",
          title: "Liar",
          artist: "Camila Cabello",
          durationSeconds: 185,
          source: "app",
          playedAt: now - 60_000,
        }),
      ).toBe(true);
      expect(
        recordPlay(db, {
          userId: "hist-user",
          videoId: "vid-1",
          title: "Liar",
          source: "app",
          playedAt: now - 30_000,
        }),
      ).toBe(false); // same track inside the dedupe window
      recordPlay(db, {
        userId: "hist-user",
        videoId: "vid-2",
        title: "Love Me Again",
        artist: "John Newman",
        durationSeconds: 200,
        source: "api",
        apiKeyId: key.id,
        playedAt: now - 120_000,
      });
      recordPlay(db, {
        userId: "hist-user",
        videoId: "vid-3",
        title: "Nightcall",
        artist: "Kavinsky",
        source: "app",
        playedAt: now - 5_000,
      });

      const list = await fetch(`${running.base}/api/history?limit=10`, {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as {
        plays: Array<{ videoId: string; source: string; apiKeyLabel: string | null }>;
        hasMore: boolean;
      };
      expect(listed.plays.map((play) => play.videoId)).toEqual(["vid-3", "vid-1", "vid-2"]);
      expect(listed.plays[1]!.source).toBe("app");
      expect(listed.plays[2]!.source).toBe("api");
      expect(listed.plays[2]!.apiKeyLabel).toBe("Stereo");

      const stats = (await (
        await fetch(`${running.base}/api/history/stats`, { headers: { cookie } })
      ).json()) as {
        totalPlays: number;
        totalListeningSeconds: number;
        bySource: { app: number; api: number };
        topTracks: Array<{ videoId: string; title: string }>;
      };
      expect(stats.totalPlays).toBe(3);
      expect(stats.totalListeningSeconds).toBe(385);
      expect(stats.bySource).toEqual({ app: 2, api: 1 });
      expect(stats.topTracks).toHaveLength(3);
      expect(stats.topTracks.map((track) => track.title)).toContain("Liar");

      // Separate statistics per API key.
      const keys = (await (
        await fetch(`${running.base}/api/keys`, { headers: { cookie } })
      ).json()) as {
        keys: Array<{
          label: string;
          stats: { totalPlays: number; playsLast7Days: number; lastPlayedAt: number | null };
        }>;
      };
      const stereo = keys.keys.find((entry) => entry.label === "Stereo");
      expect(stereo?.stats).toMatchObject({ totalPlays: 1, playsLast7Days: 1 });
      expect(stereo?.stats.lastPlayedAt).toBeTruthy();

      // History is per user: another account sees an empty list.
      seedUser(db, "hist-other", "Other User");
      const otherSid = createSession(db, "hist-other");
      const otherList = (await (
        await fetch(`${running.base}/api/history`, {
          headers: { cookie: `${SESSION_COOKIE}=${otherSid}` },
        })
      ).json()) as { plays: unknown[] };
      expect(otherList.plays).toEqual([]);

      // Clearing removes only the caller's plays.
      const cleared = await fetch(`${running.base}/api/history`, {
        method: "DELETE",
        headers: { origin: running.base, cookie },
      });
      expect(((await cleared.json()) as { removed: number }).removed).toBe(3);
      const after = (await (
        await fetch(`${running.base}/api/history`, { headers: { cookie } })
      ).json()) as { plays: unknown[] };
      expect(after.plays).toEqual([]);
    });
  });

  describe("recommendations and Web Push", () => {
    it("sends between accounts, serves inbox/sent, marks read, deletes, and lists the directory", async () => {
      seedUser(db, "rec-sender", "Sender Sam");
      seedUser(db, "rec-recipient", "Recipient Rita");
      seedUser(db, "rec-bystander", "Bystander Bea");
      const senderCookie = `${SESSION_COOKIE}=${createSession(db, "rec-sender")}`;
      const recipientCookie = `${SESSION_COOKIE}=${createSession(db, "rec-recipient")}`;
      const jsonHeaders = {
        origin: running.base,
        "content-type": "application/json",
        cookie: senderCookie,
      };

      // 1. Sending requires the three identifying fields.
      const missingFields = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ recipientId: "rec-recipient" }),
      });
      expect(missingFields.status).toBe(400);

      // 2. Unknown recipients and self-recommendations are refused.
      const unknown = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ recipientId: "nobody", videoId: "vid-9", title: "Song" }),
      });
      expect(unknown.status).toBe(404);
      const self = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ recipientId: "rec-sender", videoId: "vid-9", title: "Song" }),
      });
      expect(self.status).toBe(400);

      // 3. A successful send snapshots the track and returns the item.
      const sent = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          recipientId: "rec-recipient",
          videoId: "vid-rec-1",
          title: "Nightcall",
          artist: "Kavinsky",
          album: "OutRun",
          artworkUrl: "https://i.ytimg.com/vi/vid-rec-1/mqdefault.jpg",
          durationSeconds: 242.4,
          note: "This bassline!",
        }),
      });
      expect(sent.status).toBe(201);
      const created = (await sent.json()) as {
        recommendation: {
          id: string;
          senderName: string;
          recipientName: string | null;
          durationSeconds: number;
          note: string;
        };
      };
      expect(created.recommendation.senderName).toBe("Sender Sam");
      // The send response names the recipient so the Sent list can render it.
      expect(created.recommendation.recipientName).toBe("Recipient Rita");
      expect(created.recommendation.durationSeconds).toBe(242);
      expect(created.recommendation.note).toBe("This bassline!");

      // 4. The recipient's inbox carries it, unread, with the sender name.
      const inbox = (await (
        await fetch(`${running.base}/api/recommendations`, { headers: { cookie: recipientCookie } })
      ).json()) as {
        recommendations: Array<{ id: string; videoId: string; senderName: string; readAt: number | null }>;
        unreadCount: number;
      };
      expect(inbox.recommendations).toHaveLength(1);
      expect(inbox.recommendations[0]).toMatchObject({
        videoId: "vid-rec-1",
        senderName: "Sender Sam",
        readAt: null,
      });
      expect(inbox.unreadCount).toBe(1);

      // The sender's sent list shows the same item, carrying the recipient's
      // name for display; the bystander sees none.
      const sentList = (await (
        await fetch(`${running.base}/api/recommendations/sent`, { headers: { cookie: senderCookie } })
      ).json()) as { recommendations: Array<{ videoId: string; recipientName: string | null }> };
      expect(sentList.recommendations.map((item) => item.videoId)).toEqual(["vid-rec-1"]);
      expect(sentList.recommendations[0].recipientName).toBe("Recipient Rita");
      const bystanderInbox = (await (
        await fetch(`${running.base}/api/recommendations`, {
          headers: { cookie: `${SESSION_COOKIE}=${createSession(db, "rec-bystander")}` },
        })
      ).json()) as { recommendations: unknown[]; unreadCount: number };
      expect(bystanderInbox.recommendations).toEqual([]);
      expect(bystanderInbox.unreadCount).toBe(0);

      // 5. Marking read is recipient-only and idempotent.
      const readByBystander = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}/read`,
        {
          method: "POST",
          headers: { origin: running.base, cookie: `${SESSION_COOKIE}=${createSession(db, "rec-bystander")}` },
        },
      );
      expect(readByBystander.status).toBe(404);
      const read = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}/read`,
        {
          method: "POST",
          headers: { origin: running.base, cookie: recipientCookie },
        },
      );
      expect(await read.json()).toEqual({ ok: true });
      const readAgain = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}/read`,
        {
          method: "POST",
          headers: { origin: running.base, cookie: recipientCookie },
        },
      );
      expect(readAgain.status).toBe(200);
      const afterRead = (await (
        await fetch(`${running.base}/api/recommendations?unread=1`, { headers: { cookie: recipientCookie } })
      ).json()) as { recommendations: unknown[]; unreadCount: number };
      expect(afterRead.recommendations).toEqual([]);
      expect(afterRead.unreadCount).toBe(0);

      // 6. A bystander cannot delete; the recipient may dismiss.
      const foreignDelete = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}`,
        {
          method: "DELETE",
          headers: { origin: running.base, cookie: `${SESSION_COOKIE}=${createSession(db, "rec-bystander")}` },
        },
      );
      expect(foreignDelete.status).toBe(404);
      const recipientDelete = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}`,
        {
          method: "DELETE",
          headers: { origin: running.base, cookie: recipientCookie },
        },
      );
      expect(await recipientDelete.json()).toEqual({ ok: true });
      const gone = await fetch(
        `${running.base}/api/recommendations/${created.recommendation.id}`,
        {
          method: "DELETE",
          headers: { origin: running.base, cookie: recipientCookie },
        },
      );
      expect(gone.status).toBe(404);

      // 7. The sender can also retract from their sent list.
      const retractSend = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ recipientId: "rec-recipient", videoId: "vid-rec-2", title: "Reclaim" }),
      });
      expect(retractSend.status).toBe(201);
      const retractId = ((await retractSend.json()) as { recommendation: { id: string } }).recommendation.id;
      const retract = await fetch(`${running.base}/api/recommendations/${retractId}`, {
        method: "DELETE",
        headers: { origin: running.base, cookie: senderCookie },
      });
      expect(await retract.json()).toEqual({ ok: true });
    });

    it("refuses every route without authentication", async () => {
      for (const [method, route] of [
        ["GET", ""],
        ["GET", "sent"],
        ["GET", "directory"],
        ["POST", ""],
      ] as const) {
        const res = await fetch(`${running.base}/api/recommendations${route ? `/${route}` : ""}`, {
          method,
          headers: { origin: running.base, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(res.status, `${method} ${route || "/"}`).toBe(401);
      }
      const pushKey = await fetch(`${running.base}/api/push/vapid-public-key`);
      expect(pushKey.status).toBe(401);
      for (const route of ["subscribe", "unsubscribe"]) {
        const res = await fetch(`${running.base}/api/push/${route}`, {
          method: "POST",
          headers: { origin: running.base, "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status, route).toBe(401);
      }
    });

    it("serves the account directory without self or emails", async () => {
      seedUser(db, "dir-user-a", "Alice");
      seedUser(db, "dir-user-b", "Bob");
      const cookie = `${SESSION_COOKIE}=${createSession(db, "dir-user-a")}`;
      const res = await fetch(`${running.base}/api/recommendations/directory`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // Names may appear, but email addresses never do.
      expect(text).not.toContain("@example.com");
      const { users } = JSON.parse(text) as { users: Array<{ id: string; name: string }> };
      const ids = users.map((user) => user.id);
      expect(ids).toContain("dir-user-b");
      expect(ids).not.toContain("dir-user-a");
    });

    it("accepts bearer API keys for recommendations but not for push subscriptions", async () => {
      seedUser(db, "rec-key-user", "Key User");
      seedUser(db, "rec-key-peer", "Key Peer");
      const cookie = `${SESSION_COOKIE}=${createSession(db, "rec-key-user")}`;
      const keyRes = await fetch(`${running.base}/api/keys`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json", cookie },
        body: JSON.stringify({ label: "Mobile" }),
      });
      expect(keyRes.status).toBe(201);
      const key = ((await keyRes.json()) as { key: string }).key;
      expect(key).toMatch(/^odk_/);

      // A future mobile client reuses the same surface with the bearer key.
      const sent = await fetch(`${running.base}/api/recommendations`, {
        method: "POST",
        headers: {
          origin: running.base,
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ recipientId: "rec-key-peer", videoId: "vid-key-1", title: "Api Song" }),
      });
      expect(sent.status).toBe(201);
      const inbox = await fetch(`${running.base}/api/recommendations`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(inbox.status).toBe(200);

      // Push subscription management refuses API keys (credential-adjacent).
      const subscribe = await fetch(`${running.base}/api/push/subscribe`, {
        method: "POST",
        headers: {
          origin: running.base,
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          endpoint: "https://push.example/key-sub",
          keys: { p256dh: "a", auth: "b" },
        }),
      });
      expect(subscribe.status).toBe(401);
    });

    it("manages Web Push subscriptions and serves a stable VAPID key", async () => {
      seedUser(db, "push-user");
      const cookie = `${SESSION_COOKIE}=${createSession(db, "push-user")}`;
      const jsonHeaders = {
        origin: running.base,
        "content-type": "application/json",
        cookie,
      };

      // The VAPID public key is generated once and stays stable.
      const keyRes = await fetch(`${running.base}/api/push/vapid-public-key`, {
        headers: { cookie },
      });
      expect(keyRes.status).toBe(200);
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      expect(publicKey.length).toBeGreaterThan(20);
      const keyAgain = await fetch(`${running.base}/api/push/vapid-public-key`, {
        headers: { cookie },
      });
      expect(((await keyAgain.json()) as { publicKey: string }).publicKey).toBe(publicKey);

      // Subscribing stores the endpoint; incomplete bodies are refused.
      const bad = await fetch(`${running.base}/api/push/subscribe`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ endpoint: "https://push.example/sub-1" }),
      });
      expect(bad.status).toBe(400);
      const subscribe = await fetch(`${running.base}/api/push/subscribe`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          endpoint: "https://push.example/sub-1",
          keys: { p256dh: "p256dh-key", auth: "auth-key" },
        }),
      });
      expect(subscribe.status).toBe(201);
      const row = db
        .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
        .get("https://push.example/sub-1") as { user_id: string } | undefined;
      expect(row?.user_id).toBe("push-user");

      // Unsubscribing removes only the caller's row.
      const foreign = await fetch(`${running.base}/api/push/unsubscribe`, {
        method: "POST",
        headers: {
          origin: running.base,
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${createSession(db, "rec-key-peer")}`,
        },
        body: JSON.stringify({ endpoint: "https://push.example/sub-1" }),
      });
      expect(await foreign.json()).toEqual({ ok: true, removed: false });
      const unsubscribe = await fetch(`${running.base}/api/push/unsubscribe`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ endpoint: "https://push.example/sub-1" }),
      });
      expect(await unsubscribe.json()).toEqual({ ok: true, removed: true });
    });
  });

  describe("API documentation page", () => {
    it("renders docs/API.md as HTML at /docs", async () => {
      const res = await fetch(`${running.base}/docs`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("html");
      const html = await res.text();
      expect(html).toContain("OpenDeck API");
      // Structural proof the markdown renderer ran: tables and code blocks.
      expect(html).toContain("<table>");
      expect(html).toContain('class="code"');
      expect(html).toContain('aria-label="API reference contents"');
      // No inline scripts (the CSP blocks them; the page needs none).
      expect(html).not.toContain("<script");
    });
  });

  describe("settings", () => {
    it("requires a session for every operation", async () => {
      for (const route of ["get", "set", "remove"]) {
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

      // The QR handoff refuses to arm attempts without a provider too.
      const qrStart = await fetch(`${running.base}/api/auth/google/qr/start`, {
        method: "POST",
        headers: { origin: running.base, "content-type": "application/json" },
        body: "{}",
      });
      expect(qrStart.status).toBe(503);

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

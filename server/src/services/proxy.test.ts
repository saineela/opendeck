import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Db } from "../db.js";
import { createSession } from "../middleware/session.js";
import { configureProxyHosts, forwardProxyRequest, isHostAllowed } from "./proxy.js";
import { saveYouTubeTokens } from "./youtubeAccount.js";
import { saveYouTubeCookies } from "./youtubeCookies.js";
import type { YouTubeTokens } from "./youtubeOAuth.js";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    appUrl: "http://localhost:4000",
    dataDir: "/tmp/jamac-test",
    dbPath: ":memory:",
    appSecret: crypto.createHash("sha256").update("proxy-test-secret").digest(),
    google: {
      clientId: "",
      clientSecret: "",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scopes: ["openid"],
      providerName: "Google",
      configured: false,
    },
    adminEmails: [],
    registration: { enabled: true, inviteCode: null },
    passwordLoginEnabled: true,
    totpIssuer: "OpenDeck",
    trustProxy: false,
    serveClient: false,
    ...overrides,
  };
}

describe("isHostAllowed", () => {
  it("allows the documented HTTPS hosts", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=x",
      "https://music.youtube.com/",
      "https://m.youtube.com/",
      "https://youtubei.googleapis.com/youtubei/v1/browse",
      "https://i.ytimg.com/vi/x/hq.jpg",
      "https://ytimg.com/",
      "https://rr3---sn.googlevideo.com/videoplayback",
      "https://api.lrclib.net/api/get",
      "https://lrclib.net/",
      "https://lyrics-api.boidu.dev/api/search",
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://ggpht.com/avatar",
      "https://googleusercontent.com/x",
      "https://www.youtube.com./", // trailing-dot host normalizes
    ]) {
      expect(isHostAllowed(new URL(url)), url).toBe(true);
    }
  });

  it("rejects everything that is not an allowlisted HTTPS host", () => {
    for (const url of [
      "http://www.youtube.com/", // plain HTTP
      "https://evil.com/",
      "https://notyoutube.com/", // suffix trickery
      "https://youtube.com.evil.com/",
      "https://evil-youtube.com/",
      "https://localhost:4000/",
      "https://127.0.0.1/",
      "https://example.com/youtubei/v1/browse",
      "ftp://www.youtube.com/",
      "file:///etc/passwd",
    ]) {
      expect(isHostAllowed(new URL(url)), url).toBe(false);
    }
  });

  it("honors YT_PROXY_EXTRA_HOSTS through configureProxyHosts", () => {
    process.env.YT_PROXY_EXTRA_HOSTS = "example.org, cdn.example.net";
    try {
      configureProxyHosts(makeConfig());
      expect(isHostAllowed(new URL("https://example.org/"))).toBe(true);
      expect(isHostAllowed(new URL("https://cdn.example.net/file.mp3"))).toBe(true);
      expect(isHostAllowed(new URL("https://other.example.org/"))).toBe(true);
      expect(isHostAllowed(new URL("https://example.org.evil.com/"))).toBe(false);
    } finally {
      delete process.env.YT_PROXY_EXTRA_HOSTS;
      configureProxyHosts(makeConfig());
    }
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stubFetch(
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(request);
    return handler(request);
  });
  return calls;
}

describe("forwardProxyRequest", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    configureProxyHosts(makeConfig());
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  it("rejects unparseable URLs", async () => {
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      { url: "not a url", method: "GET", headers: {} },
      null,
    );
    expect(result).toEqual({ ok: false, status: 400, error: "Invalid URL." });
  });

  it("rejects hosts outside the allowlist without contacting upstream", async () => {
    const calls = stubFetch(() => new Response("never"));
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      { url: "https://evil.com/steal", method: "GET", headers: {} },
      null,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("evil.com");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects unsupported HTTP methods", async () => {
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      { url: "https://www.youtube.com/", method: "PATCH", headers: {} },
      null,
    );
    expect(result).toEqual({ ok: false, status: 400, error: "Method not allowed: PATCH" });
  });

  it("strips credential and browser-identifying request headers", async () => {
    const calls = stubFetch(
      () => new Response("ok", { status: 200, headers: { "x-upstream": "yes" } }),
    );
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      {
        url: "https://www.youtube.com/youtubei/v1/browse",
        method: "POST",
        headers: {
          Cookie: "VISITOR_INFO1_LIVE=secret",
          Authorization: "Bearer client-supplied",
          Origin: "https://evil.example",
          Referer: "https://evil.example/page",
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": "1",
        },
        body_base64: Buffer.from("{}").toString("base64"),
      },
      null,
    );
    expect(result.ok).toBe(true);
    const sent = calls[0];
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.authorization).toBeUndefined();
    // Caller-supplied Origin/Referer are discarded and replaced with the value
    // YouTube's own web client sends — a foreign origin turns playback into
    // "Video unavailable".
    expect(sent.headers.origin).toBe("https://www.youtube.com");
    expect(sent.headers.referer).toBe("https://www.youtube.com/");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["x-youtube-client-name"]).toBe("1");
  });

  it("matches Origin to the request host for WEB_REMIX calls on www.youtube.com", async () => {
    // youtubei.js routes WEB_REMIX InnerTube calls to www.youtube.com. Sending
    // Origin: https://music.youtube.com made YouTube reject every search and
    // browse with 400 "Origin doesn't match Host for XD3".
    const calls = stubFetch(() => new Response("{}"));
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      {
        url: "https://www.youtube.com/youtubei/v1/search",
        method: "POST",
        headers: { "content-type": "application/json" },
        body_base64: Buffer.from(
          JSON.stringify({ context: { client: { clientName: "WEB_REMIX" } }, query: "adele" }),
        ).toString("base64"),
      },
      null,
    );
    expect(result.ok).toBe(true);
    const sent = calls[0];
    expect(sent.headers.origin).toBe("https://www.youtube.com");
    expect(sent.headers["x-origin"]).toBe("https://www.youtube.com");
    expect(sent.headers.referer).toBe("https://www.youtube.com/");
  });

  it("returns upstream status, headers, and body", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "content-type": "application/json", "set-cookie": "tracking=1" },
        }),
    );
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      { url: "https://lrclib.net/api/get", method: "GET", headers: {} },
      null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.output.headers["content-type"]).toBe("application/json");
      // Upstream Set-Cookie must not be relayed to the browser.
      expect(result.output.headers["set-cookie"]).toBeUndefined();
      const body = JSON.parse(Buffer.from(result.output.body_base64, "base64").toString());
      expect(body).toEqual({ ok: true });
    }
  });

  it("maps upstream network failures to 502", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await forwardProxyRequest(
      db,
      makeConfig(),
      { url: "https://www.youtube.com/", method: "GET", headers: {} },
      null,
    );
    expect(result).toEqual({ ok: false, status: 502, error: "Upstream request failed." });
  });

  describe("YouTube OAuth bearer injection", () => {
    const config = makeConfig();

    function linkUser(): string {
      const userId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
      ).run(userId, `sub-${userId}`, "Test User", "t@example.com", Date.now(), Date.now());
      const tokens: YouTubeTokens = {
        access_token: "yt-access-token",
        refresh_token: "yt-refresh-token",
        expiry_date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scope: "https://www.googleapis.com/auth/youtube",
        token_type: "Bearer",
      };
      saveYouTubeTokens(db, config, userId, tokens);
      return userId;
    }

    it("injects a Bearer token for InnerTube endpoints when the user linked YouTube", async () => {
      const userId = linkUser();
      const sessionId = createSession(db, userId);
      expect(sessionId).toBeTruthy();

      const calls = stubFetch(() => new Response("{}"));
      const result = await forwardProxyRequest(
        db,
        config,
        {
          url: "https://music.youtube.com/youtubei/v1/browse",
          method: "POST",
          headers: { "content-type": "application/json" },
          body_base64: Buffer.from(JSON.stringify({ context: { client: { clientName: "TVHTML5" } } })).toString("base64"),
        },
        userId,
      );
      expect(result.ok).toBe(true);
      expect(calls[0].headers.authorization).toBe("Bearer yt-access-token");
      expect(calls[0].headers["x-goog-request-time"]).toMatch(/^\d+$/);
    });

    it.each(["ANDROID", "IOS", "ANDROID_MUSIC", "TVHTML5_SIMPLY", "TVHTML5_SIMPLY_EMBEDDED_PLAYER"])(
      "does not inject TV-only OAuth into %s player requests",
      async (clientName) => {
        const userId = linkUser();
        const calls = stubFetch(() => new Response("{}"));
        const body = JSON.stringify({ context: { client: { clientName } } });

        const result = await forwardProxyRequest(
          db,
          config,
          {
            url: "https://www.youtube.com/youtubei/v1/player",
            method: "POST",
            headers: { "content-type": "application/json" },
            body_base64: Buffer.from(body).toString("base64"),
          },
          userId,
        );

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].headers.authorization).toBeUndefined();
      },
    );

    it("does not inject a Bearer token for non-InnerTube hosts or paths", async () => {
      const userId = linkUser();
      const calls = stubFetch(() => new Response(""));

      await forwardProxyRequest(
        db,
        config,
        { url: "https://i.ytimg.com/vi/x/hq.jpg", method: "GET", headers: {} },
        userId,
      );
      await forwardProxyRequest(
        db,
        config,
        {
          url: "https://www.youtube.com/watch?v=x",
          method: "GET",
          headers: {},
        },
        userId,
      );
      expect(calls).toHaveLength(2);
      expect(calls[0].headers.authorization).toBeUndefined();
      expect(calls[1].headers.authorization).toBeUndefined();
    });

    it("does not inject anything for anonymous callers", async () => {
      const userId = linkUser();
      const calls = stubFetch(() => new Response("{}"));
      await forwardProxyRequest(
        db,
        config,
        { url: "https://www.youtube.com/youtubei/v1/player", method: "POST", headers: {} },
        null,
      );
      expect(userId).toBeTruthy();
      expect(calls[0].headers.authorization).toBeUndefined();
    });
  });

  describe("YouTube session cookies", () => {
    const config = makeConfig();
    const cookie = "SID=session; HSID=hsid; SSID=ssid; APISID=apisid; SAPISID=sapisid";

    function linkUserWithCookies(): string {
      const userId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
      ).run(userId, `sub-${userId}`, "Test User", "t@example.com", Date.now(), Date.now());
      const saved = saveYouTubeCookies(db, config, userId, cookie);
      expect(saved.ok).toBe(true);
      return userId;
    }

    it("signs WEB_REMIX requests with the stored cookie instead of Bearer", async () => {
      const userId = linkUserWithCookies();
      const calls = stubFetch(() => new Response("{}"));
      const body = JSON.stringify({ context: { client: { clientName: "WEB_REMIX" } } });

      const result = await forwardProxyRequest(
        db,
        config,
        {
          url: "https://music.youtube.com/youtubei/v1/player",
          method: "POST",
          headers: { "content-type": "application/json" },
          body_base64: Buffer.from(body).toString("base64"),
        },
        userId,
      );

      expect(result.ok).toBe(true);
      expect(calls[0].headers.cookie).toBe(cookie);
      expect(calls[0].headers.authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
      expect(calls[0].headers["x-goog-authuser"]).toBe("0");
      expect(calls[0].headers.origin).toBe("https://music.youtube.com");
    });

    it("keeps TVHTML5 on OAuth, never mixing the cookie into a TV request", async () => {
      const userId = linkUserWithCookies();
      const tokens: YouTubeTokens = {
        access_token: "yt-access-token",
        refresh_token: "yt-refresh-token",
        expiry_date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scope: "https://www.googleapis.com/auth/youtube",
        token_type: "Bearer",
      };
      saveYouTubeTokens(db, config, userId, tokens);

      const calls = stubFetch(() => new Response("{}"));
      const body = JSON.stringify({ context: { client: { clientName: "TVHTML5" } } });
      await forwardProxyRequest(
        db,
        config,
        {
          url: "https://music.youtube.com/youtubei/v1/player",
          method: "POST",
          headers: { "content-type": "application/json" },
          body_base64: Buffer.from(body).toString("base64"),
        },
        userId,
      );

      expect(calls[0].headers.authorization).toBe("Bearer yt-access-token");
      expect(calls[0].headers.cookie).toBeUndefined();
    });

    it("authenticates the music.youtube.com metadata bootstrap", async () => {
      const userId = linkUserWithCookies();
      const calls = stubFetch(() => new Response("<html></html>"));
      await forwardProxyRequest(
        db,
        config,
        { url: "https://music.youtube.com/", method: "GET", headers: {} },
        userId,
      );
      expect(calls[0].headers.cookie).toBe(cookie);
      expect(calls[0].headers.authorization).toBeUndefined();
      expect(calls[0].headers.referer).toBe("https://music.youtube.com/");
    });

    it("never sends the cookie to a non-YouTube host", async () => {
      const userId = linkUserWithCookies();
      const calls = stubFetch(() => new Response(""));
      await forwardProxyRequest(
        db,
        config,
        { url: "https://i.ytimg.com/vi/x/hq.jpg", method: "GET", headers: {} },
        userId,
      );
      expect(calls[0].headers.cookie).toBeUndefined();
    });
  });
});

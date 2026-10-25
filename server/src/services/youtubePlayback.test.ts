import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Db } from "../db.js";
import { saveYouTubeTokens } from "./youtubeAccount.js";
import { saveYouTubeCookies } from "./youtubeCookies.js";
import { resolveYouTubePlayback } from "./youtubePlayback.js";
import type { YouTubeTokens } from "./youtubeOAuth.js";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    appUrl: "http://localhost:4000",
    dataDir: "/tmp/opendeck-test",
    dbPath: ":memory:",
    appSecret: crypto.createHash("sha256").update("playback-test-secret").digest(),
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

const VIDEO_ID = "Kx7B-XvmFtE";
const AUDIO_URL = "https://rr1---sn-test.googlevideo.com/videoplayback?id=audio";
const SESSION_COOKIE =
  "SID=session-value; SAPISID=sapisid-value; APISID=apisid-value; __Secure-3PSID=psid";

function playerResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playabilityStatus: { status: "OK" },
    streamingData: {
      adaptiveFormats: [
        {
          itag: 251,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160000,
          url: "https://rr1---sn-test.googlevideo.com/videoplayback?id=opus",
        },
        {
          itag: 140,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 129000,
          url: AUDIO_URL,
        },
      ],
    },
    ...overrides,
  };
}

interface StubCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubPlayer(
  handler: (request: StubCall) => Response | Promise<Response>,
): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const request = {
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          String(value),
        ]),
      ),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(request);
    return handler(request);
  });
  return calls;
}

/** Player calls only — the visitor-data bootstrap is a plain page GET. */
function playerCalls(calls: StubCall[]): StubCall[] {
  return calls.filter((call) => call.url.includes("/youtubei/v1/player"));
}

describe("resolveYouTubePlayback", () => {
  let db: Db;
  const config = makeConfig();

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  function createUser(): string {
    const userId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    ).run(userId, `sub-${userId}`, "Test User", "t@example.com", Date.now(), Date.now());
    return userId;
  }

  function linkOAuth(userId: string): void {
    const tokens: YouTubeTokens = {
      access_token: "yt-access-token",
      refresh_token: "yt-refresh-token",
      expiry_date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scope: "https://www.googleapis.com/auth/youtube",
      token_type: "Bearer",
    };
    saveYouTubeTokens(db, config, userId, tokens);
  }

  function linkCookies(userId: string): void {
    const saved = saveYouTubeCookies(db, config, userId, SESSION_COOKIE);
    expect(saved.ok).toBe(true);
  }

  it("resolves anonymously when no credential is linked", async () => {
    const userId = createUser();
    const calls = stubPlayer(() => new Response(JSON.stringify(playerResponse()), { status: 200 }));

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.playback.url).toBe(AUDIO_URL);
      expect(result.playback.mimeType).toContain("audio/mp4");
      expect(result.playback.itag).toBe(140);
      expect(result.playback.via).toBe("anonymous");
    }

    const players = playerCalls(calls);
    expect(players.length).toBeGreaterThan(0);
    expect(players[0].headers.authorization).toBeUndefined();
    expect(players[0].headers.cookie).toBeUndefined();
  });

  it("prefers the imported session and signs it with SAPISIDHASH", async () => {
    const userId = createUser();
    linkCookies(userId);
    const calls = stubPlayer(() => new Response(JSON.stringify(playerResponse()), { status: 200 }));

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.playback.via).toBe("cookies");

    const first = playerCalls(calls)[0];
    expect(first.url).toContain("music.youtube.com/youtubei/v1/player");
    expect(first.headers.cookie).toContain("SAPISID=sapisid-value");
    expect(first.headers.authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    expect(first.headers.origin).toBe("https://music.youtube.com");
    expect(JSON.parse(first.body)).toMatchObject({
      videoId: VIDEO_ID,
      context: { client: { clientName: "WEB_REMIX" } },
    });
  });

  it("falls back to the OAuth TV client when the cookie client refuses", async () => {
    const userId = createUser();
    linkOAuth(userId);
    const calls = stubPlayer((request) =>
      request.body.includes("WEB_REMIX")
        ? new Response(JSON.stringify({ playabilityStatus: { status: "UNPLAYABLE" } }), { status: 200 })
        : new Response(JSON.stringify(playerResponse()), { status: 200 }),
    );

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.playback.via).toBe("tv");

    const tv = playerCalls(calls).find((call) => call.body.includes("TVHTML5"));
    expect(tv?.headers.authorization).toBe("Bearer yt-access-token");
    expect(tv?.headers["x-goog-authuser"]).toBe("0");
  });

  it("prefers the highest bitrate when high quality is requested", async () => {
    const userId = createUser();
    stubPlayer(() => new Response(JSON.stringify(playerResponse()), { status: 200 }));

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID, "high");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.playback.itag).toBe(251);
  });

  it("asks for the playback sign-in when YouTube gates the track and no cookie is saved", async () => {
    const userId = createUser();
    stubPlayer(() =>
      new Response(
        JSON.stringify({
          playabilityStatus: {
            status: "LOGIN_REQUIRED",
            reason: "Sign in to confirm you're not a bot",
          },
        }),
        { status: 200 },
      ),
    );

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("Playback sign-in");
      expect(result.attempts.length).toBeGreaterThan(0);
      expect(result.attempts[0].playability).toBe("LOGIN_REQUIRED");
    }
  });

  it("asks the user to re-import cookies when the saved session is rejected", async () => {
    const userId = createUser();
    linkCookies(userId);
    stubPlayer(() =>
      new Response(
        JSON.stringify({
          playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" },
        }),
        { status: 200 },
      ),
    );

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toMatch(/re-import/i);
    }
  });

  it("skips DRM and ciphered formats rather than handing one to the browser", async () => {
    const userId = createUser();
    stubPlayer(() =>
      new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          streamingData: {
            adaptiveFormats: [
              {
                itag: 140,
                mimeType: "audio/mp4",
                bitrate: 129000,
                url: AUDIO_URL,
                drmFamilies: ["WIDEVINE"],
              },
              {
                itag: 251,
                mimeType: "audio/webm",
                bitrate: 160000,
                signatureCipher: "s=abc&url=https%3A%2F%2Fgooglevideo.com%2Fvideoplayback",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.reason).toMatch(/ciphered|no playable audio|could not play/i);
      expect(result.attempts.every((attempt) => attempt.playableFormats === 0)).toBe(true);
    }
  });

  it("surfaces an upstream rejection without leaking the token", async () => {
    const userId = createUser();
    linkOAuth(userId);
    stubPlayer(() => new Response("denied", { status: 403 }));

    const result = await resolveYouTubePlayback(db, config, userId, VIDEO_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("yt-access-token");
      expect(result.attempts.some((attempt) => attempt.playability === "HTTP_403")).toBe(true);
    }
  });
});

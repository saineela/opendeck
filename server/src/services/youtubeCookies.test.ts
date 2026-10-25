import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Db } from "../db.js";
import {
  buildYouTubeCookieHeaders,
  clearYouTubeCookies,
  getYouTubeCookieStatus,
  isYouTubeHost,
  loadYouTubeCookies,
  normalizeCookieHeader,
  saveYouTubeCookies,
  verifyYouTubeSession,
} from "./youtubeCookies.js";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 4000,
    appUrl: "http://localhost:4000",
    dataDir: "/tmp/opendeck-test",
    dbPath: ":memory:",
    appSecret: crypto.createHash("sha256").update("cookies-test-secret").digest(),
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

const SAMPLE_COOKIE =
  "SID=abc123; HSID=def456; SSID=ghi789; APISID=jkl012; SAPISID=mno345; __Secure-3PSID=pqr678";
const COOKIE_WITH_PREFIX = `Cookie: ${SAMPLE_COOKIE}`;

describe("normalizeCookieHeader", () => {
  it("accepts a full YouTube session header and strips the Cookie: prefix", () => {
    const result = normalizeCookieHeader(COOKIE_WITH_PREFIX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cookie).toContain("SID=abc123");
      expect(result.cookie).toContain("SAPISID=mno345");
      expect(result.cookie).not.toMatch(/^Cookie:/i);
    }
  });

  it("rejects headers without a session or SAPISID", () => {
    expect(normalizeCookieHeader("VISITOR_INFO1_LIVE=abc").ok).toBe(false);
    expect(normalizeCookieHeader("SID=abc; HSID=def").ok).toBe(false);
  });

  it("rejects header injection and empty input", () => {
    expect(normalizeCookieHeader("").ok).toBe(false);
    expect(normalizeCookieHeader("SID=abc; SAPISID=def\r\nX-Evil: 1").ok).toBe(false);
  });

  it("deduplicates repeated names and drops malformed pairs", () => {
    const result = normalizeCookieHeader(
      "SID=old; SID=new; SAPISID=secret; broken; =empty; POLITE=1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cookie).toContain("SID=new");
      expect(result.cookie).not.toContain("SID=old");
      expect(result.cookie).not.toContain("=empty");
    }
  });
});

describe("buildYouTubeCookieHeaders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs a WEB_REMIX InnerTube request with SAPISIDHASH", () => {
    const timestamp = Math.floor(Date.parse("2026-10-25T12:00:00Z") / 1000);
    const expectedHash = crypto
      .createHash("sha1")
      .update(`${timestamp} mno345 https://music.youtube.com`)
      .digest("hex");

    const headers = buildYouTubeCookieHeaders(
      SAMPLE_COOKIE,
      new URL("https://music.youtube.com/youtubei/v1/player"),
    );

    expect(headers.cookie).toBe(SAMPLE_COOKIE);
    expect(headers.authorization).toBe(`SAPISIDHASH ${timestamp}_${expectedHash}`);
    expect(headers["x-goog-authuser"]).toBe("0");
    expect(headers.origin).toBe("https://music.youtube.com");
    expect(headers.referer).toBe("https://music.youtube.com/");
  });

  it("uses www.youtube.com for the regular web client", () => {
    const headers = buildYouTubeCookieHeaders(
      SAMPLE_COOKIE,
      new URL("https://www.youtube.com/youtubei/v1/player"),
    );
    expect(headers.origin).toBe("https://www.youtube.com");
    expect(headers.authorization).toMatch(/^SAPISIDHASH /);
  });

  it("matches the origin to the hop, never the client name", () => {
    // youtubei.js sends every InnerTube call — including WEB_REMIX ones — to
    // www.youtube.com. Claiming music.youtube.com there makes YouTube answer
    // "400 Bad request: Origin doesn't match Host for XD3", which broke
    // search, browse and cached playlist refreshes while playback kept working.
    const headers = buildYouTubeCookieHeaders(
      SAMPLE_COOKIE,
      new URL("https://www.youtube.com/youtubei/v1/search"),
    );
    expect(headers.origin).toBe("https://www.youtube.com");
    expect(headers["x-origin"]).toBe("https://www.youtube.com");
    expect(headers.referer).toBe("https://www.youtube.com/");

    const timestamp = Math.floor(Date.parse("2026-10-25T12:00:00Z") / 1000);
    const expectedHash = crypto
      .createHash("sha1")
      .update(`${timestamp} mno345 https://www.youtube.com`)
      .digest("hex");
    expect(headers.authorization).toBe(`SAPISIDHASH ${timestamp}_${expectedHash}`);
  });

  it("attaches the cookie to plain page loads without signing them", () => {
    const headers = buildYouTubeCookieHeaders(
      SAMPLE_COOKIE,
      new URL("https://music.youtube.com/"),
    );
    expect(headers.cookie).toBe(SAMPLE_COOKIE);
    expect(headers.authorization).toBeUndefined();
  });

  it("recognises only youtube.com hosts", () => {
    expect(isYouTubeHost(new URL("https://music.youtube.com/"))).toBe(true);
    expect(isYouTubeHost(new URL("https://www.youtube.com/"))).toBe(true);
    expect(isYouTubeHost(new URL("https://googlevideo.com/"))).toBe(false);
    expect(isYouTubeHost(new URL("https://notyoutube.com/"))).toBe(false);
  });
});

describe("cookie storage", () => {
  let db: Db;
  let testUserId = "";
  const config = makeConfig();

  beforeEach(() => {
    db = openDatabase(":memory:");
    testUserId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    ).run(testUserId, `sub-${testUserId}`, "Test User", "t@example.com", Date.now(), Date.now());
  });

  afterEach(() => {
    db.close();
  });

  function userId(): string {
    return testUserId;
  }

  it("encrypts the header at rest and decrypts it for the proxy", () => {
    const saved = saveYouTubeCookies(db, config, userId(), SAMPLE_COOKIE);
    expect(saved.ok).toBe(true);

    const row = db.prepare("SELECT ciphertext FROM youtube_cookies WHERE user_id = ?").get(userId()) as
      | { ciphertext: string }
      | undefined;
    expect(row?.ciphertext).toBeTruthy();
    expect(row?.ciphertext).not.toContain("SID=abc123");

    expect(loadYouTubeCookies(db, config, userId())).toBe(SAMPLE_COOKIE);
    expect(getYouTubeCookieStatus(db, userId())).toMatchObject({ linked: true });
  });

  it("clears the stored header", () => {
    saveYouTubeCookies(db, config, userId(), SAMPLE_COOKIE);
    clearYouTubeCookies(db, userId());
    expect(loadYouTubeCookies(db, config, userId())).toBeNull();
    expect(getYouTubeCookieStatus(db, userId())).toEqual({ linked: false, updatedAt: null });
  });

  it("refuses to store an invalid header", () => {
    const result = saveYouTubeCookies(db, config, userId(), "SID=only");
    expect(result.ok).toBe(false);
    expect(loadYouTubeCookies(db, config, userId())).toBeNull();
  });
});

describe("verifyYouTubeSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubAccountMenu(body: string, status = 200): Array<Record<string, string>> {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(body, { status });
    });
    return calls;
  }

  it("recognises a signed-in session and reports the account", async () => {
    const calls = stubAccountMenu(
      JSON.stringify({ actions: [{ accountName: { simpleText: "Sai" } }] }),
    );
    const result = await verifyYouTubeSession("SID=abc; SAPISID=def");
    expect(result).toEqual({ authenticated: true, accountName: "Sai" });
    expect(calls[0].authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    expect(calls[0].cookie).toBe("SID=abc; SAPISID=def");
  });

  it("rejects a header that YouTube treats as signed-out", async () => {
    stubAccountMenu(JSON.stringify({ actions: [] }));
    const result = await verifyYouTubeSession("SID=abc; SAPISID=def");
    expect(result.authenticated).toBe(false);
    expect(result.accountName).toBeNull();
  });

  it("rejects an upstream error instead of claiming success", async () => {
    stubAccountMenu("no", 401);
    const result = await verifyYouTubeSession("SID=abc; SAPISID=def");
    expect(result).toEqual({ authenticated: false, accountName: null, status: 401 });
  });
});

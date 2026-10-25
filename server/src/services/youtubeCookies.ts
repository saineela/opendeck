import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { decryptJson, encryptJson } from "./tokenCipher.js";
import { logger } from "../logger.js";

/**
 * Per-user YouTube session cookies.
 *
 * Why this exists: a device-code OAuth token only authenticates InnerTube's
 * TVHTML5 client. The web clients that can actually play gated music tracks
 * (WEB_REMIX and friends) require a browser session — the same thing the
 * JAMC desktop app gets from its embedded YouTube login. A web deployment
 * cannot read the browser's youtube.com cookies, so the user imports the
 * cookie header once, and the server signs every youtube.com request with
 * SAPISIDHASH exactly like the official web client (and JAMC's tauriFetch).
 *
 * Security:
 *  - encrypted at rest with APP_SECRET (same envelope as OAuth tokens);
 *  - never returned to the browser (status only reports linked/updatedAt);
 *  - only injected on *.youtube.com, never on any other allowlisted host;
 *  - never logged.
 */

const MAX_COOKIE_HEADER_BYTES = 12_000;
const MAX_COOKIES = 100;
const AUTHUSER = "0";
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

const SAPISID_NAMES = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"] as const;

export interface YouTubeCookieStatus {
  linked: boolean;
  updatedAt: number | null;
}

interface CookiePayload {
  cookie: string;
  updatedAt: number;
}

interface CookieRow {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  updated_at: number;
}

/**
 * Parses and normalizes a pasted `Cookie:` header. Rejects input that cannot
 * authenticate a YouTube web session instead of silently storing junk.
 */
export function normalizeCookieHeader(raw: string): { ok: true; cookie: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "A cookie header is required." };
  const trimmed = raw.trim().replace(/^cookie:\s*/i, "");
  if (!trimmed) return { ok: false, error: "The cookie header is empty." };
  if (trimmed.length > MAX_COOKIE_HEADER_BYTES) {
    return { ok: false, error: "The cookie header is too large." };
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, error: "The cookie header contains invalid characters." };
  }

  const cookies = new Map<string, string>();
  for (const part of trimmed.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !COOKIE_NAME_RE.test(name) || !value) continue;
    // Header values are opaque; reject anything that could break the header.
    if (/[\s;,]/.test(value)) continue;
    cookies.set(name, value);
  }

  if (cookies.size === 0) {
    return { ok: false, error: "No name=value cookie pairs were found." };
  }
  if (cookies.size > MAX_COOKIES) {
    return { ok: false, error: "Too many cookies were provided." };
  }

  const hasSession = cookies.has("SID") || cookies.has("__Secure-1PSID") || cookies.has("__Secure-3PSID");
  if (!hasSession) {
    return { ok: false, error: "The header is missing the YouTube session cookie (SID)." };
  }
  if (!SAPISID_NAMES.some((name) => cookies.has(name))) {
    return { ok: false, error: "The header is missing SAPISID, which is required to sign requests." };
  }

  return {
    ok: true,
    cookie: [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

export function saveYouTubeCookies(
  db: Db,
  config: ServerConfig,
  userId: string,
  raw: string,
): { ok: true; status: YouTubeCookieStatus } | { ok: false; error: string } {
  const normalized = normalizeCookieHeader(raw);
  if (!normalized.ok) return normalized;

  const updatedAt = Date.now();
  const payload = encryptJson(config.appSecret, {
    cookie: normalized.cookie,
    updatedAt,
  } satisfies CookiePayload);
  db.prepare(
    `INSERT INTO youtube_cookies (user_id, ciphertext, nonce, auth_tag, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       nonce = excluded.nonce,
       auth_tag = excluded.auth_tag,
       updated_at = excluded.updated_at`,
  ).run(userId, payload.ciphertext, payload.nonce, payload.authTag, updatedAt);

  return { ok: true, status: { linked: true, updatedAt } };
}

export function getYouTubeCookieStatus(db: Db, userId: string): YouTubeCookieStatus {
  const row = db.prepare("SELECT updated_at FROM youtube_cookies WHERE user_id = ?").get(userId) as
    | { updated_at: number }
    | undefined;
  return { linked: Boolean(row), updatedAt: row?.updated_at ?? null };
}

export function clearYouTubeCookies(db: Db, userId: string): void {
  db.prepare("DELETE FROM youtube_cookies WHERE user_id = ?").run(userId);
}

/** Decrypts the stored header; returns null when absent or unreadable. */
export function loadYouTubeCookies(db: Db, config: ServerConfig, userId: string): string | null {
  const row = db
    .prepare("SELECT ciphertext, nonce, auth_tag, updated_at FROM youtube_cookies WHERE user_id = ?")
    .get(userId) as CookieRow | undefined;
  if (!row) return null;
  try {
    const payload = decryptJson<CookiePayload>(config.appSecret, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    });
    if (typeof payload?.cookie !== "string" || !payload.cookie) return null;
    return payload.cookie;
  } catch (error) {
    logger.warn("youtube.cookies decryption failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface YouTubeSessionVerification {
  authenticated: boolean;
  accountName: string | null;
  status?: number;
}

/**
 * Proves that an imported cookie header is a signed-in YouTube session.
 *
 * `document.cookie` cannot see httpOnly cookies, so a header copied from a
 * bookmarklet is missing HSID/SSID and YouTube treats it as signed-out. This
 * calls the account menu with the same SAPISIDHASH the player will use and
 * reports whether an account answered — an import that cannot play is
 * rejected instead of silently stored.
 */
export async function verifyYouTubeSession(cookie: string): Promise<YouTubeSessionVerification> {
  const url = new URL("https://music.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false");
  const version = "1.20250219.01.00";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...buildYouTubeCookieHeaders(cookie, url),
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "x-youtube-client-name": "67",
        "x-youtube-client-version": version,
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB_REMIX", clientVersion: version, hl: "en", gl: "US" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { authenticated: false, accountName: null, status: response.status };
    }
    const text = await response.text();
    const accountName = text.match(/"accountName":\{"simpleText":"([^"]+)"/)?.[1] ?? null;
    const authenticated = Boolean(accountName) || text.includes('"activeAccount"');
    return { authenticated, accountName };
  } catch (error) {
    logger.warn("youtube.cookies verification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { authenticated: false, accountName: null };
  }
}

export function isYouTubeHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host === "youtube.com" || host.endsWith(".youtube.com");
}

function getSapisid(cookie: string): string | null {
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!SAPISID_NAMES.includes(name as (typeof SAPISID_NAMES)[number])) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

/**
 * The Origin/Referer a YouTube web client sends for a request.
 *
 * This MUST be the request's own host. YouTube validates it against the Host
 * header and answers `400 Bad request: Origin doesn't match Host for XD3.`
 * otherwise — which is what happens when a WEB_REMIX request is sent to
 * www.youtube.com (youtubei.js routes every InnerTube call there) while the
 * origin claims music.youtube.com. Deriving it from the client name instead
 * of the hop breaks search, browse and every other WEB_REMIX call.
 */
export function youTubeRequestOrigin(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "youtube.com") return "https://www.youtube.com";
  return `https://${host}`;
}

/**
 * Builds the headers a signed-in YouTube web client would send.
 *
 * SAPISIDHASH = SHA1("<unix-seconds> <SAPISID> <origin>"), which is exactly
 * the scheme YouTube's own web bundle (and JAMC's desktop proxy) uses. The
 * signed origin must equal the Origin header actually sent, or YouTube
 * rejects the signature.
 */
export function buildYouTubeCookieHeaders(
  cookie: string,
  url: URL,
): Record<string, string> {
  const origin = youTubeRequestOrigin(url);
  const headers: Record<string, string> = {
    cookie,
    "x-goog-authuser": AUTHUSER,
    origin,
    "x-origin": origin,
    referer: `${origin}/`,
  };

  const signable = url.pathname.startsWith("/youtubei/") || url.pathname.startsWith("/api/stats/");
  if (!signable) return headers;

  const sapisid = getSapisid(cookie);
  if (!sapisid) return headers;

  const timestamp = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash("sha1")
    .update(`${timestamp} ${sapisid} ${origin}`)
    .digest("hex");
  headers.authorization = `SAPISIDHASH ${timestamp}_${hash}`;
  headers["x-goog-request-time"] = String(timestamp);
  return headers;
}

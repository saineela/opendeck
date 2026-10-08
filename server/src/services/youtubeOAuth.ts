import crypto from "node:crypto";
import { logger } from "../logger.js";

/**
 * Server-side port of youtubei.js's OAuth2 device-code flow
 * (youtubei.js `src/core/OAuth2.js`). This is how the original desktop app
 * obtains YouTube credentials — here it runs entirely on the server so the
 * browser never sees OAuth tokens.
 *
 * Flow: scrape the YouTube TV client identity, request a device + user code,
 * the user visits youtube.com/activate and enters the code, then we poll the
 * token endpoint until authorization completes.
 */

const YT_BASE = "https://www.youtube.com";
const DEVICE_CODE_URL = `${YT_BASE}/o/oauth2/device/code`;
const TOKEN_URL = `${YT_BASE}/o/oauth2/token`;
const REVOKE_URL = `${YT_BASE}/o/oauth2/revoke`;
const YTTV_URL = `${YT_BASE}/tv`;
const SCOPE = "http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content";
const TV_USER_AGENT = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";

const TV_SCRIPT_REGEX = /<script\s+id="base-js"\s+src="([^"]+)"[^>]*><\/script>/;
const CLIENT_IDENTITY_REGEX = /clientId:"(?<client_id>[^"]+)",[^"]*?:"(?<client_secret>[^"]+)"/;

export interface YouTubeClientIdentity {
  client_id: string;
  client_secret: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface YouTubeTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: string;
  scope?: string;
  token_type?: string;
}

export type PollResult =
  | { status: "pending"; error: string }
  | { status: "success"; tokens: YouTubeTokens }
  | { status: "denied"; error: string }
  | { status: "expired"; error: string }
  | { status: "error"; error: string };

let clientIdentityPromise: Promise<YouTubeClientIdentity> | null = null;

async function fetchJson<T>(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T & { error?: string; error_code?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json()) as T & { error?: string; error_code?: string };
  if (!response.ok && !payload.error && !payload.error_code) {
    throw new Error(`YouTube OAuth endpoint ${new URL(url).pathname} returned HTTP ${response.status}.`);
  }
  return payload;
}

/**
 * Retrieve the YouTube TV OAuth client identity exactly the way youtubei.js
 * does: load the TV shell, find the base script, then extract client id/secret.
 */
export async function getYouTubeClientIdentity(): Promise<YouTubeClientIdentity> {
  if (!clientIdentityPromise) {
    clientIdentityPromise = (async () => {
      const shellResponse = await fetch(YTTV_URL, {
        headers: {
          "user-agent": TV_USER_AGENT,
          referer: `${YT_BASE}/tv`,
          "accept-language": "en-US",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!shellResponse.ok) {
        throw new Error(`YouTube TV shell request failed with HTTP ${shellResponse.status}.`);
      }
      const shellHtml = await shellResponse.text();
      const scriptMatch = TV_SCRIPT_REGEX.exec(shellHtml);
      if (!scriptMatch) {
        throw new Error("Could not locate the YouTube TV base script.");
      }
      const scriptUrl = new URL(scriptMatch[1], `${YT_BASE}/`).toString();
      const scriptResponse = await fetch(scriptUrl, {
        headers: { "user-agent": TV_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!scriptResponse.ok) {
        throw new Error(`YouTube TV script request failed with HTTP ${scriptResponse.status}.`);
      }
      const scriptText = await scriptResponse.text();
      const identityMatch = CLIENT_IDENTITY_REGEX.exec(scriptText);
      if (!identityMatch?.groups?.client_id || !identityMatch.groups.client_secret) {
        throw new Error("Could not extract the YouTube OAuth client identity.");
      }
      return {
        client_id: identityMatch.groups.client_id,
        client_secret: identityMatch.groups.client_secret,
      };
    })().catch((error) => {
      clientIdentityPromise = null;
      throw error;
    });
  }
  return clientIdentityPromise;
}

/** Test hook. */
export function resetYouTubeClientIdentityCache(): void {
  clientIdentityPromise = null;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const identity = await getYouTubeClientIdentity();
  const payload = await fetchJson<DeviceCodeResponse>(DEVICE_CODE_URL, {
    client_id: identity.client_id,
    scope: SCOPE,
    device_id: crypto.randomUUID(),
    device_model: "ytlr::",
  });
  if (payload.error || payload.error_code || !payload.device_code) {
    throw new Error(
      `YouTube device code request failed: ${payload.error ?? payload.error_code ?? "unknown error"}`,
    );
  }
  return {
    device_code: payload.device_code,
    user_code: payload.user_code,
    verification_url: payload.verification_url,
    expires_in: payload.expires_in,
    interval: Math.max(2, payload.interval ?? 5),
  };
}

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_code?: string;
}

function toTokens(payload: TokenPayload): YouTubeTokens {
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("YouTube OAuth token response is missing required fields.");
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expiry_date: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
    scope: payload.scope,
    token_type: payload.token_type,
  };
}

/** One poll attempt against the token endpoint. */
export async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
  const identity = await getYouTubeClientIdentity();
  try {
    const payload = await fetchJson<TokenPayload>(TOKEN_URL, {
      client_id: identity.client_id,
      client_secret: identity.client_secret,
      code: deviceCode,
      grant_type: "http://oauth.net/grant_type/device/1.0",
    });
    if (payload.error) {
      switch (payload.error) {
        case "authorization_pending":
        case "slow_down":
          return { status: "pending", error: payload.error };
        case "access_denied":
          return { status: "denied", error: payload.error };
        case "expired_token":
          return { status: "expired", error: payload.error };
        default:
          logger.warn("youtube.oauth poll unexpected error", { error: payload.error });
          return { status: "error", error: payload.error };
      }
    }
    if (!payload.access_token) {
      return { status: "error", error: "missing_access_token" };
    }
    return { status: "success", tokens: toTokens(payload) };
  } catch (error) {
    logger.warn("youtube.oauth poll failed", { error });
    return { status: "error", error: error instanceof Error ? error.message : "poll_failed" };
  }
}

export async function refreshYouTubeTokens(tokens: YouTubeTokens): Promise<YouTubeTokens> {
  const identity = await getYouTubeClientIdentity();
  const payload = await fetchJson<TokenPayload>(TOKEN_URL, {
    client_id: identity.client_id,
    client_secret: identity.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  if (payload.error || !payload.access_token) {
    throw new Error(`YouTube token refresh failed: ${payload.error ?? "missing access token"}`);
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? tokens.refresh_token,
    expiry_date: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
    scope: payload.scope ?? tokens.scope,
    token_type: payload.token_type ?? tokens.token_type,
  };
}

export async function revokeYouTubeToken(token: string): Promise<void> {
  try {
    const identity = await getYouTubeClientIdentity();
    await fetch(
      `${REVOKE_URL}?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: identity.client_id }).toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    // Revocation is best-effort; local deletion still happens.
    logger.warn("youtube.oauth revoke failed", { error });
  }
}

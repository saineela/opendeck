import { logger } from "../logger.js";

/**
 * GVS proof-of-origin tokens from a bgutil provider process.
 *
 * YouTube binds a GVS token to the video it was minted for, and some label
 * tracks are served only up to roughly the first megabyte without one: the
 * signature answers 403 past that point, so the player stops a minute into the
 * song. The provider (`brainicism/bgutil-ytdlp-pot-provider`, port 4416) runs
 * BotGuard in its own browser and hands back a token for a video id; appending
 * it to the resolved url as `pot` makes googlevideo serve the whole file.
 *
 * Everything here is optional: with no provider configured, or a provider that
 * is down, resolve continues exactly as before.
 */

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

type CachedToken = { token: string; expiresAt: number };

const tokens = new Map<string, CachedToken>();
let unavailableUntil = 0;

export function potProviderUrl(): string | null {
  const raw = process.env.POT_PROVIDER_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * googlevideo checks a token against the client whose URL carries it, so the
 * provider has to mint for the client the format came from.
 */
export function providerClientFor(client: string): string {
  const name = client.toUpperCase();
  if (name.startsWith("IOS")) return "ios";
  if (name.startsWith("ANDROID_VR")) return "android_vr";
  if (name.startsWith("ANDROID")) return "android";
  if (name.startsWith("TV")) return "tv";
  if (name.startsWith("MWEB")) return "mweb";
  return "web";
}

export async function getGvsToken(videoId: string, client = "web"): Promise<string | undefined> {
  const base = potProviderUrl();
  if (!base || Date.now() < unavailableUntil) return undefined;

  const cacheKey = `${client}:${videoId}`;
  const cached = tokens.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const response = await fetch(`${base}/get_pot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_binding: videoId, client }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`provider answered HTTP ${response.status}.`);
    const payload = (await response.json()) as { poToken?: string; po_token?: string };
    const token = payload.poToken ?? payload.po_token;
    if (!token) throw new Error("provider response carried no token.");

    if (tokens.size >= 500) tokens.clear();
    tokens.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    logger.info("youtube.pot minted", { videoId, client, length: token.length });
    return token;
  } catch (error) {
    unavailableUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
    logger.warn("youtube.pot unavailable", {
      videoId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Reports why a token is or is not available, for /api/media/pot-check. */
export async function diagnosePot(
  videoId: string,
  client = "web",
): Promise<Record<string, unknown>> {
  const base = potProviderUrl();
  if (!base) return { configured: false };
  try {
    const response = await fetch(`${base}/get_pot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_binding: videoId, client }),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    let tokenLength = 0;
    try {
      const parsed = JSON.parse(text) as { poToken?: string; po_token?: string };
      tokenLength = (parsed.poToken ?? parsed.po_token ?? "").length;
    } catch {
      // Report the raw body instead.
    }
    return {
      configured: true,
      base,
      client,
      status: response.status,
      tokenLength,
      body: tokenLength ? undefined : text.slice(0, 300),
    };
  } catch (error) {
    return { configured: true, base, client, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Adds the token to a googlevideo url when one is available. */
export function attachPot(url: string, token: string | undefined): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("pot", token);
  return parsed.toString();
}

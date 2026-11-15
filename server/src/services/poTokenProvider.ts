import { logger } from "../logger.js";

/**
 * GVS proof-of-origin tokens from a bgutil provider process.
 *
 * YouTube binds a GVS token to the video it was minted for, and label tracks are
 * served only up to roughly their first megabyte without one: the signature
 * answers 403 past that point, so the player stops a minute into the song.
 *
 * The provider ships inside this image (see Dockerfile + entrypoint.sh) and
 * listens on loopback, so the default base is 127.0.0.1. A configured
 * POT_PROVIDER_URL is tried first and loopback is kept as a fallback, because a
 * stale or unreachable setting is otherwise invisible: it just means no tokens.
 *
 * Everything here is optional: with no provider reachable, resolve continues
 * exactly as before.
 */

const TOKEN_TTL_MS = 5 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 6_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const LOOPBACK_BASE = "http://127.0.0.1:4416";

type CachedToken = { token: string; expiresAt: number };

const tokens = new Map<string, CachedToken>();
let unavailableUntil = 0;
/** The base that last answered, so discovery costs one request. */
let activeBase: string | null = null;

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Bases to try, in order: the one that worked, the configured one, loopback. */
export function potProviderBases(): string[] {
  if (activeBase) return [activeBase];
  const bases: string[] = [];
  const configured = process.env.POT_PROVIDER_URL;
  if (configured?.trim()) bases.push(normalize(configured));
  if (process.env.NODE_ENV === "production") bases.push(LOOPBACK_BASE);
  return bases.filter((base, index) => base && bases.indexOf(base) === index);
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
  if (Date.now() < unavailableUntil) return undefined;

  const cacheKey = `${client}:${videoId}`;
  const cached = tokens.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const bases = potProviderBases();
  if (bases.length === 0) return undefined;

  for (const base of bases) {
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

      if (activeBase !== base) {
        activeBase = base;
        logger.info("youtube.pot using provider", { base });
      }
      if (tokens.size >= 500) tokens.clear();
      tokens.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
      logger.info("youtube.pot minted", { videoId, client, length: token.length });
      return token;
    } catch (error) {
      if (activeBase === base) activeBase = null;
      logger.warn("youtube.pot provider failed", {
        base,
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  unavailableUntil = Date.now() + RETRY_AFTER_FAILURE_MS;
  return undefined;
}

/** Reports why a token is or is not available, for /api/media/pot-check. */
export async function diagnosePot(
  videoId: string,
  client = "web",
): Promise<Record<string, unknown>> {
  const bases = potProviderBases();
  if (bases.length === 0) return { configured: false };

  // Every base is reported: a single aggregated failure hides which one the
  // server actually tried, which is the difference between a dead hostname and
  // a provider that is not running.
  const attempts: Array<Record<string, unknown>> = [];
  for (const base of bases) {
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
      attempts.push({
        base,
        status: response.status,
        tokenLength,
        body: tokenLength ? undefined : text.slice(0, 300),
      });
    } catch (error) {
      attempts.push({ base, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { configured: true, client, bases, attempts };
}

/** Adds the token to a googlevideo url when one is available. */
export function attachPot(url: string, token: string | undefined): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("pot", token);
  return parsed.toString();
}

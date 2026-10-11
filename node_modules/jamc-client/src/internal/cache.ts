import { logInternalWarn } from "./logging";

export const DEFAULT_CACHE_SIZE_GB = 4;

/** Default artwork budget: roughly ten thousand thumbnails at ~50 KB each. */
export const DEFAULT_ARTWORK_CACHE_SIZE_MB = 512;
/** Bounds enforced by the server; mirrored here so the field rejects bad input early. */
export const MIN_ARTWORK_CACHE_SIZE_MB = 64;
export const MAX_ARTWORK_CACHE_SIZE_MB = 65536;

export interface CacheStats {
  maxBytes: number;
  usedBytes: number;
  entryCount: number;
}

interface CacheWriteResult {
  changed: boolean;
}

/**
 * Web replacement for the desktop app's Rust disk cache commands
 * (`cache_get` / `cache_set` / …). Entries live server-side in SQLite (shared
 * per signed-in account, namespaced per user), so cache hits survive browser
 * restarts and device switches.
 */

/**
 * Reads tolerate failure (a cache probe that 401s or times out should degrade,
 * not break the page). Writes must not: swallowing an error there leaves the
 * caller showing a success message for something that never happened, so
 * `throwOnError` opts a call out of the swallow-and-return-null path.
 */
async function postCache<T>(
  path: string,
  payload: Record<string, unknown>,
  options: { throwOnError?: boolean } = {},
): Promise<T | null> {
  try {
    const response = await fetch(`/api/cache/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (options.throwOnError) throw error;
    logInternalWarn(`cache.${path} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const result = await postCache<{ value: string | null }>("get", { key });
  if (!result || result.value === null) return null;
  try {
    return JSON.parse(result.value) as T;
  } catch {
    return null;
  }
}

export async function setCachedJson<T>(key: string, value: T): Promise<boolean> {
  const serialized = JSON.stringify(value);
  const result = await postCache<CacheWriteResult>("set", { key, value: serialized });
  return result?.changed ?? false;
}

export async function getCacheStats(): Promise<CacheStats> {
  const result = await postCache<CacheStats>("stats", {});
  return result ?? { maxBytes: 0, usedBytes: 0, entryCount: 0 };
}

export async function setCacheMaxBytes(maxBytes: number): Promise<CacheStats> {
  const result = await postCache<CacheStats>("setMaxBytes", { maxBytes });
  return result ?? { maxBytes: 0, usedBytes: 0, entryCount: 0 };
}

export async function clearCache(): Promise<CacheStats> {
  const result = await postCache<CacheStats>("clear", {});
  return result ?? { maxBytes: 0, usedBytes: 0, entryCount: 0 };
}

/**
 * Artwork cache controls. Unlike the JSON cache this one is global — the same
 * thumbnail is shared by every account — so the budget and the format are
 * admin-only on the server; a non-admin caller gets a rejected promise here.
 */

export interface ArtworkCacheStats extends CacheStats {
  /** Fraction of the artwork budget in use, 0..1. */
  usageRatio: number;
}

const EMPTY_ARTWORK_STATS: ArtworkCacheStats = {
  maxBytes: 0,
  usedBytes: 0,
  entryCount: 0,
  usageRatio: 0,
};

export async function getArtworkCacheStats(): Promise<ArtworkCacheStats> {
  return (await postCache<ArtworkCacheStats>("artwork/stats", {})) ?? EMPTY_ARTWORK_STATS;
}

export async function setArtworkCacheMaxBytes(maxBytes: number): Promise<ArtworkCacheStats> {
  // Throws on 403/400/network rather than reporting zeroes as a success.
  return (
    (await postCache<ArtworkCacheStats>("artwork/setMaxBytes", { maxBytes }, { throwOnError: true })) ??
    EMPTY_ARTWORK_STATS
  );
}

/** "Format" — drops every cached picture and VACUUMs the file back down. */
export async function formatArtworkCache(): Promise<ArtworkCacheStats> {
  return (
    (await postCache<ArtworkCacheStats>("artwork/format", {}, { throwOnError: true })) ??
    EMPTY_ARTWORK_STATS
  );
}

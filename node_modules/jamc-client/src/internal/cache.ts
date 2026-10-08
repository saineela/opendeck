import { logInternalWarn } from "./logging";

export const DEFAULT_CACHE_SIZE_GB = 4;

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

async function postCache<T>(path: string, payload: Record<string, unknown>): Promise<T | null> {
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

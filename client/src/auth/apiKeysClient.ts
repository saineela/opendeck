/**
 * Per-account API keys: long-lived bearer tokens (`odk_…`) that authenticate
 * as the signed-in user on every session-authenticated endpoint.
 *
 * Management requires a real browser session — the server rejects bearer-key
 * callers on these routes (no self-minting). The plaintext key is returned
 * exactly once, at creation; afterwards only its prefix is ever visible.
 */

export interface ApiKeyInfo {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Successful requests made through the HTTP API with this key. */
  stats: {
    totalRequests: number;
    requestsLast7Days: number;
    lastRequestAt: number | null;
    requestsByRoute: Array<{ route: string; requests: number }>;
    totalPlays: number;
    playsLast7Days: number;
    lastPlayedAt: number | null;
  };
}

export interface CreatedApiKey {
  id: string;
  label: string;
  /** Plaintext `odk_…` key — shown to the user once, never stored server-side. */
  key: string;
  keyPrefix: string;
  createdAt: number;
}

async function requestJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/keys${pathname}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `API key request failed with HTTP ${response.status}.`);
  }
  return payload as unknown as T;
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const payload = await requestJson<{ keys: ApiKeyInfo[] }>("/");
  return payload.keys;
}

export async function createApiKey(label: string): Promise<CreatedApiKey> {
  return requestJson<CreatedApiKey>("", {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

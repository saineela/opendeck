/** Play-history endpoints (`/api/history`) — see docs/API.md §2.13. */

export interface HistoryPlay {
  id: string;
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  source: "app" | "api";
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  playedAt: number;
}

export interface HistoryPageResult {
  plays: HistoryPlay[];
  hasMore: boolean;
  nextCursor: number | null;
}

export interface HistoryStats {
  totalPlays: number;
  totalListeningSeconds: number;
  playsToday: number;
  plays7d: number;
  bySource: { app: number; api: number };
  topTracks: Array<{
    videoId: string;
    title: string;
    artist: string;
    plays: number;
    lastPlayedAt: number;
  }>;
  topArtists: Array<{ artist: string; plays: number }>;
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `History request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

export function fetchHistoryPage(limit = 50, before?: number): Promise<HistoryPageResult> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", String(before));
  return requestJson<HistoryPageResult>(`/api/history?${params.toString()}`);
}

export function fetchHistoryStats(): Promise<HistoryStats> {
  return requestJson<HistoryStats>("/api/history/stats");
}

export async function clearHistory(): Promise<number> {
  const result = await requestJson<{ ok: true; removed: number }>("/api/history", {
    method: "DELETE",
  });
  return result.removed;
}

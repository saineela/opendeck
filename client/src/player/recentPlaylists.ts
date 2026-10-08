const STORAGE_KEY = "yt-music-dock:recent-playlists";
const CHANGE_EVENT = "yt-music-dock:recent-playlists-changed";

type RecentPlaylistMap = Record<string, number>;

function loadRecentPlaylists(): RecentPlaylistMap {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};

    const recentPlaylists: RecentPlaylistMap = {};
    for (const [playlistId, playedAt] of Object.entries(stored)) {
      if (
        playlistId.length > 0
        && typeof playedAt === "number"
        && Number.isFinite(playedAt)
      ) {
        recentPlaylists[playlistId] = playedAt;
      }
    }
    return recentPlaylists;
  } catch {
    return {};
  }
}

export function getRecentPlaylistTimestamp(playlistId: string): number {
  return loadRecentPlaylists()[playlistId] ?? 0;
}

export function markPlaylistPlayed(playlistId: string): void {
  const recentPlaylists = loadRecentPlaylists();
  recentPlaylists[playlistId] = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recentPlaylists));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeToRecentPlaylists(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };

  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

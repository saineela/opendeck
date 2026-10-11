import type { Playlist, Track } from "../datasource/types";
import { logInternalWarn } from "../internal/logging";

/**
 * Client for the server's per-user library (`/api/library`).
 *
 * This is *this account's* library — playlists and likes stored against the
 * OpenDeck user, so they follow the account to any browser. It is separate
 * from the linked YouTube Music library, which is merged alongside it in
 * LibraryController.
 *
 * Every call is same-origin with the session cookie; 401 means "signed out"
 * and is surfaced to callers so they can prompt instead of failing silently.
 */

export const APP_PLAYLIST_PREFIX = "pl-";

export interface AppPlaylist {
  id: string;
  name: string;
  description: string | null;
  artworkUrl: string | null;
  trackCount: number;
  updatedAt: number;
}

interface ServerTrack {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  addedAt?: number;
}

export interface LibrarySnapshotPayload {
  playlists: Array<AppPlaylist & { tracks: ServerTrack[] }>;
  likedSongs: ServerTrack[];
  counts: { playlists: number; likedSongs: number };
}

/** Server playlist ids (`pl-…`) are namespaced so they never collide with YouTube's. */
export function isAppPlaylist(playlist: Pick<Playlist, "id">): boolean {
  return playlist.id.startsWith(APP_PLAYLIST_PREFIX);
}

export function serverTrackToTrack(track: ServerTrack): Track {
  const mapped: Track = {
    id: track.id,
    source: (track.source as Track["source"]) ?? "youtube",
    title: track.title,
    artist: track.artist,
  };
  if (track.album) mapped.album = track.album;
  if (track.artworkUrl) mapped.artworkUrl = track.artworkUrl;
  if (typeof track.durationSeconds === "number") mapped.durationSec = track.durationSeconds;
  if (track.addedAt !== undefined) mapped.playlistItemId = `${track.id}:${track.addedAt}`;
  return mapped;
}

/** Client track → payload the server accepts. */
export function trackToServerPayload(track: Track): Record<string, unknown> {
  return {
    id: track.id,
    source: track.source,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    artworkUrl: track.artworkUrl ?? null,
    durationSec: track.durationSec ?? null,
  };
}

export function appPlaylistToPlaylist(playlist: AppPlaylist): Playlist {
  const mapped: Playlist = {
    id: playlist.id,
    title: playlist.name,
    owner: "OpenDeck",
    kind: "app",
    isEditable: true,
    isSaved: true,
  };
  if (playlist.artworkUrl) mapped.artworkUrl = playlist.artworkUrl;
  return mapped;
}

export class SignedOutError extends Error {
  constructor() {
    super("Sign in to save your library to this server.");
    this.name = "SignedOutError";
  }
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (response.status === 401) throw new SignedOutError();
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Library request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}

function post<T>(pathname: string, body: unknown): Promise<T> {
  return request<T>(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function fetchLibrarySnapshot(): Promise<LibrarySnapshotPayload> {
  return request<LibrarySnapshotPayload>("/api/library");
}

export async function createAppPlaylist(name: string): Promise<AppPlaylist> {
  const result = await post<{ playlist: AppPlaylist }>("/api/library/playlists", { name });
  return result.playlist;
}

export async function renameAppPlaylist(id: string, name: string): Promise<AppPlaylist> {
  const result = await request<{ playlist: AppPlaylist }>(`/api/library/playlists/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return result.playlist;
}

export function deleteAppPlaylist(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/library/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function addTracksToAppPlaylist(
  id: string,
  tracks: Track[],
): Promise<{ added: number; replaced: number; trackCount: number }> {
  return post(`/api/library/playlists/${encodeURIComponent(id)}/tracks`, {
    tracks: tracks.map(trackToServerPayload),
  });
}

export function removeTrackFromAppPlaylist(id: string, trackId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/library/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`,
    { method: "DELETE" },
  );
}

export function reorderAppPlaylist(id: string, trackIds: string[]): Promise<{ trackCount: number }> {
  return post(`/api/library/playlists/${encodeURIComponent(id)}/reorder`, { trackIds });
}

export async function fetchAppPlaylistTracks(id: string): Promise<Track[]> {
  const result = await request<{ tracks: ServerTrack[] }>(
    `/api/library/playlists/${encodeURIComponent(id)}`,
  );
  return result.tracks.map(serverTrackToTrack);
}

export function likeAppTrack(track: Track): Promise<{ liked: boolean; total: number }> {
  return request(`/api/library/likes/${encodeURIComponent(track.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(trackToServerPayload(track)),
  });
}

export function unlikeAppTrack(trackId: string): Promise<{ liked: boolean; total: number }> {
  return request(`/api/library/likes/${encodeURIComponent(trackId)}`, { method: "DELETE" });
}

/**
 * Best-effort fire-and-forget write. Used where a failure must not roll back
 * an optimistic UI update that the user already sees (the next snapshot pull
 * reconciles any drift).
 */
export function persistLikeQuietly(track: Track, liked: boolean): void {
  void (liked ? likeAppTrack(track) : unlikeAppTrack(track.id)).catch((error) => {
    logInternalWarn("appLibrary.persistLike failed", {
      error: error instanceof Error ? error.message : String(error),
      liked,
    });
  });
}

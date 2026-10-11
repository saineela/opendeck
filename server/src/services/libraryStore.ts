import crypto from "node:crypto";
import type { Db } from "../db.js";

/**
 * Per-user library storage: playlists, their ordered tracks, and liked songs.
 *
 * Every statement is scoped by `user_id`, so one account can never read or
 * mutate another's rows — a wrong id and someone else's id both read as
 * "not found". These rows are the app's own library (created in OpenDeck);
 * YouTube Music's library stays a separate, linked-account view.
 */

export const MAX_PLAYLISTS_PER_USER = 500;
export const MAX_TRACKS_PER_PLAYLIST = 1000;
export const MAX_LIKED_SONGS = 20_000;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1000;

export interface StoredTrack {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
}

export interface StoredPlaylist {
  id: string;
  name: string;
  description: string | null;
  artworkUrl: string | null;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
}

export interface StoredPlaylistTrack extends StoredTrack {
  position: number;
  addedAt: number;
}

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  artwork_url: string | null;
  created_at: number;
  updated_at: number;
  track_count: number;
}

interface TrackRow {
  track_id: string;
  source: string;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  duration_seconds: number | null;
  position?: number;
  added_at: number;
}

/** Input accepted from the client for a single track. */
export interface TrackInput {
  id: string;
  source?: string;
  title?: string;
  artist?: string;
  album?: string | null;
  artworkUrl?: string | null;
  durationSec?: number | null;
}

/** Result of validating a track: every field is now concrete. */
export interface NormalizedTrack {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
}

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

function clampInt(value: unknown, fallback: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || null;
}

/** Validates and normalises an incoming track payload. */
export function normalizeTrackInput(value: unknown): NormalizedTrack {
  if (!value || typeof value !== "object") {
    throw new LibraryError("A track payload is required.", 400);
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id || id.length > 256) {
    throw new LibraryError("A track id of at most 256 characters is required.", 400);
  }
  const source =
    typeof candidate.source === "string" && candidate.source.trim()
      ? candidate.source.trim().slice(0, 32)
      : "youtube";
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 300) : "";
  if (!title) {
    throw new LibraryError("A track title is required.", 400);
  }
  return {
    id,
    source,
    title,
    artist: (typeof candidate.artist === "string" ? candidate.artist : "").trim().slice(0, 300),
    album: optionalString(candidate.album, 300),
    artworkUrl: optionalString(candidate.artworkUrl, 2048),
    durationSeconds: clampInt(candidate.durationSec, null),
  };
}

function mapTrack(row: TrackRow, withPosition: boolean): StoredPlaylistTrack | StoredTrack {
  const base: StoredTrack = {
    id: row.track_id,
    source: row.source,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    durationSeconds: row.duration_seconds,
  };
  return withPosition
    ? { ...base, position: row.position ?? 0, addedAt: row.added_at }
    : base;
}

function mapPlaylist(row: PlaylistRow): StoredPlaylist {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    artworkUrl: row.artwork_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trackCount: row.track_count,
  };
}

/* ---------------------------------------------------------------------- *
 * Playlists
 * ---------------------------------------------------------------------- */

export function listPlaylists(db: Db, userId: string): StoredPlaylist[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.artwork_url, p.created_at, p.updated_at,
              COUNT(t.track_id) AS track_count
         FROM playlists p
         LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
        WHERE p.user_id = ?
        GROUP BY p.id
        ORDER BY p.updated_at DESC`,
    )
    .all(userId) as unknown as PlaylistRow[];
  return rows.map(mapPlaylist);
}

function playlistOwner(db: Db, userId: string, playlistId: string): PlaylistRow | null {
  const row = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.artwork_url, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count
         FROM playlists p
        WHERE p.id = ? AND p.user_id = ?`,
    )
    .get(playlistId, userId) as PlaylistRow | undefined;
  return row ?? null;
}

export function getPlaylist(
  db: Db,
  userId: string,
  playlistId: string,
): { playlist: StoredPlaylist; tracks: StoredPlaylistTrack[] } | null {
  const row = playlistOwner(db, userId, playlistId);
  if (!row) return null;
  const tracks = db
    .prepare(
      `SELECT track_id, source, title, artist, album, artwork_url, duration_seconds, position, added_at
         FROM playlist_tracks
        WHERE playlist_id = ?
        ORDER BY position ASC, added_at ASC`,
    )
    .all(playlistId) as unknown as TrackRow[];
  return {
    playlist: mapPlaylist(row),
    tracks: tracks.map((track) => mapTrack(track, true) as StoredPlaylistTrack),
  };
}

export function createPlaylist(
  db: Db,
  userId: string,
  input: { name: unknown; description?: unknown; artworkUrl?: unknown },
): StoredPlaylist {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  if (!name) {
    throw new LibraryError(`A playlist name of 1-${MAX_NAME_LENGTH} characters is required.`, 400);
  }
  const description = optionalString(input.description, MAX_DESCRIPTION_LENGTH);
  const artworkUrl = optionalString(input.artworkUrl, 2048);

  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?")
    .get(userId) as { n: number };
  if (existing.n >= MAX_PLAYLISTS_PER_USER) {
    throw new LibraryError(`You have reached the ${MAX_PLAYLISTS_PER_USER} playlist limit.`, 413);
  }

  const now = Date.now();
  const id = `pl-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO playlists (id, user_id, name, description, artwork_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, description, artworkUrl, now, now);
  return {
    id,
    name,
    description,
    artworkUrl,
    createdAt: now,
    updatedAt: now,
    trackCount: 0,
  };
}

export function updatePlaylist(
  db: Db,
  userId: string,
  playlistId: string,
  input: { name?: unknown; description?: unknown; artworkUrl?: unknown },
): StoredPlaylist {
  const current = playlistOwner(db, userId, playlistId);
  if (!current) throw new LibraryError("Playlist not found.", 404);

  const name =
    input.name === undefined
      ? current.name
      : typeof input.name === "string"
        ? input.name.trim().slice(0, MAX_NAME_LENGTH)
        : "";
  if (!name) {
    throw new LibraryError(`A playlist name of 1-${MAX_NAME_LENGTH} characters is required.`, 400);
  }
  const description =
    input.description === undefined ? current.description : optionalString(input.description, MAX_DESCRIPTION_LENGTH);
  const artworkUrl =
    input.artworkUrl === undefined ? current.artwork_url : optionalString(input.artworkUrl, 2048);

  const now = Date.now();
  db.prepare(
    "UPDATE playlists SET name = ?, description = ?, artwork_url = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  ).run(name, description, artworkUrl, now, playlistId, userId);
  return { ...mapPlaylist({ ...current, name, description, artwork_url: artworkUrl, updated_at: now }) };
}

export function deletePlaylist(db: Db, userId: string, playlistId: string): boolean {
  // playlist_tracks cascades from the playlists row.
  const result = db.prepare("DELETE FROM playlists WHERE id = ? AND user_id = ?").run(playlistId, userId);
  return Number(result.changes) > 0;
}

function touchPlaylist(db: Db, userId: string, playlistId: string): void {
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ? AND user_id = ?").run(
    Date.now(),
    playlistId,
    userId,
  );
}

/* ---------------------------------------------------------------------- *
 * Playlist tracks
 * ---------------------------------------------------------------------- */

export function addTracksToPlaylist(
  db: Db,
  userId: string,
  playlistId: string,
  inputs: unknown,
): { added: number; replaced: number; trackCount: number; trackIds: string[] } {
  if (!playlistOwner(db, userId, playlistId)) {
    throw new LibraryError("Playlist not found.", 404);
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new LibraryError("A non-empty `tracks` array is required.", 400);
  }
  if (inputs.length > 200) {
    throw new LibraryError("Add at most 200 tracks per request.", 413);
  }
  const tracks = inputs.map(normalizeTrackInput);
  // Deduplicate within the batch so a repeated id counts (and lands) once.
  const uniqueTracks = [...new Map(tracks.map((track) => [track.id, track])).values()];

  const current = db
    .prepare("SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?")
    .get(playlistId) as { n: number };
  const uniqueNew = uniqueTracks.filter((track) => {
    const present = db
      .prepare("SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
      .get(playlistId, track.id);
    return !present;
  }).length;
  if (current.n + uniqueNew > MAX_TRACKS_PER_PLAYLIST) {
    throw new LibraryError(`Playlists are limited to ${MAX_TRACKS_PER_PLAYLIST} tracks.`, 413);
  }

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO playlist_tracks
       (playlist_id, position, track_id, source, title, artist, album, artwork_url, duration_seconds, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(playlist_id, track_id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       album = excluded.album,
       artwork_url = excluded.artwork_url,
       duration_seconds = excluded.duration_seconds`,
  );
  // An existing row keeps its own position: re-adding a track refreshes its
  // metadata without moving it out of the order the user arranged.
  const existingRow = db.prepare(
    "SELECT position FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
  );
  let position =
    ((db
      .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM playlist_tracks WHERE playlist_id = ?")
      .get(playlistId) as { p: number }).p ?? -1) + 1;
  const added: string[] = [];
  let replaced = 0;

  db.exec("BEGIN");
  try {
    for (const track of uniqueTracks) {
      const present = existingRow.get(playlistId, track.id) as { position: number } | undefined;
      if (present) replaced += 1;
      else added.push(track.id);
      insert.run(
        playlistId,
        present ? present.position : position,
        track.id,
        track.source,
        track.title,
        track.artist,
        track.album,
        track.artworkUrl,
        track.durationSeconds,
        now,
      );
      if (!present) position += 1;
    }
    touchPlaylist(db, userId, playlistId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as {
      n: number;
    }
  ).n;
  return { added: added.length, replaced, trackCount: total, trackIds: added };
}

export function removeTrackFromPlaylist(
  db: Db,
  userId: string,
  playlistId: string,
  trackId: string,
): boolean {
  if (!playlistOwner(db, userId, playlistId)) {
    throw new LibraryError("Playlist not found.", 404);
  }
  const result = db
    .prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
    .run(playlistId, trackId);
  if (Number(result.changes) === 0) return false;
  touchPlaylist(db, userId, playlistId);
  return true;
}

/**
 * Applies an explicit ordering. Ids not mentioned keep their relative order
 * after the supplied prefix, which makes partial reorders from a drag
 * handler safe instead of silently dropping tracks.
 */
export function reorderPlaylistTracks(
  db: Db,
  userId: string,
  playlistId: string,
  trackIds: unknown,
): { trackCount: number } {
  if (!playlistOwner(db, userId, playlistId)) {
    throw new LibraryError("Playlist not found.", 404);
  }
  if (!Array.isArray(trackIds) || trackIds.some((id) => typeof id !== "string")) {
    throw new LibraryError("`trackIds` must be an array of track ids.", 400);
  }
  const claimed = new Set(trackIds as string[]);
  if (claimed.size !== trackIds.length) {
    throw new LibraryError("`trackIds` must not contain duplicates.", 400);
  }

  const existing = (
    db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?").all(playlistId) as Array<{
      track_id: string;
    }>
  ).map((row) => row.track_id);
  const unknownIds = (trackIds as string[]).filter((id) => !existing.includes(id));
  if (unknownIds.length > 0) {
    throw new LibraryError("One or more tracks are not in this playlist.", 400);
  }

  const ordered = [...(trackIds as string[]), ...existing.filter((id) => !claimed.has(id))];
  const update = db.prepare(
    "UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?",
  );
  db.exec("BEGIN");
  try {
    ordered.forEach((id, index) => update.run(index, playlistId, id));
    touchPlaylist(db, userId, playlistId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { trackCount: ordered.length };
}

/* ---------------------------------------------------------------------- *
 * Liked songs
 * ---------------------------------------------------------------------- */

export function listLikedSongs(db: Db, userId: string): StoredTrack[] {
  const rows = db
    .prepare(
      `SELECT track_id, source, title, artist, album, artwork_url, duration_seconds, liked_at
         FROM liked_songs
        WHERE user_id = ?
        -- A bulk sync stamps every row with the same millisecond, so the
        -- tiebreak preserves the order the client sent (newest first).
        ORDER BY liked_at DESC, rowid ASC`,
    )
    .all(userId) as unknown as TrackRow[];
  return rows.map((row) => mapTrack(row, false) as StoredTrack);
}

export function likeTrack(db: Db, userId: string, input: unknown): { liked: boolean; total: number } {
  const track = normalizeTrackInput(input);
  const count = db.prepare("SELECT COUNT(*) AS n FROM liked_songs WHERE user_id = ?").get(userId) as {
    n: number;
  };
  const already = db
    .prepare("SELECT 1 FROM liked_songs WHERE user_id = ? AND track_id = ?")
    .get(userId, track.id);
  if (!already && count.n >= MAX_LIKED_SONGS) {
    throw new LibraryError(`You have reached the ${MAX_LIKED_SONGS} liked song limit.`, 413);
  }
  db.prepare(
    `INSERT INTO liked_songs
       (user_id, track_id, source, title, artist, album, artwork_url, duration_seconds, liked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       album = excluded.album,
       artwork_url = excluded.artwork_url,
       duration_seconds = excluded.duration_seconds`,
  ).run(
    userId,
    track.id,
    track.source,
    track.title,
    track.artist,
    track.album,
    track.artworkUrl,
    track.durationSeconds,
    Date.now(),
  );
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM liked_songs WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  return { liked: true, total };
}

export function unlikeTrack(db: Db, userId: string, trackId: string): { liked: false; total: number } {
  db.prepare("DELETE FROM liked_songs WHERE user_id = ? AND track_id = ?").run(userId, trackId);
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM liked_songs WHERE user_id = ?").get(userId) as { n: number }
  ).n;
  return { liked: false, total };
}

/* ---------------------------------------------------------------------- *
 * Bulk snapshot sync
 * ---------------------------------------------------------------------- */

export interface LibrarySnapshot {
  playlists: Array<{
    id?: string;
    name: string;
    description?: string | null;
    artworkUrl?: string | null;
    tracks: TrackInput[];
  }>;
  likedSongs: TrackInput[];
}

export function getLibrarySnapshot(db: Db, userId: string): {
  playlists: Array<StoredPlaylist & { tracks: StoredPlaylistTrack[] }>;
  likedSongs: StoredTrack[];
  counts: { playlists: number; likedSongs: number };
} {
  const playlists = listPlaylists(db, userId).map((playlist) => {
    const detail = getPlaylist(db, userId, playlist.id);
    return { ...playlist, tracks: detail?.tracks ?? [] };
  });
  const likedSongs = listLikedSongs(db, userId);
  return {
    playlists,
    likedSongs,
    counts: { playlists: playlists.length, likedSongs: likedSongs.length },
  };
}

/**
 * Replaces the caller's library with the supplied snapshot.
 *
 * Deletions are implicit (anything absent is dropped), which is what a
 * device-to-device sync needs: the client owns a complete view of its
 * library and pushes it whole. Runs in one transaction so a partial push can
 * never leave a half-applied library behind.
 */
export function replaceLibrarySnapshot(db: Db, userId: string, snapshot: unknown): {
  playlists: number;
  likedSongs: number;
  tracks: number;
} {
  if (!snapshot || typeof snapshot !== "object") {
    throw new LibraryError("A snapshot object is required.", 400);
  }
  const body = snapshot as LibrarySnapshot;
  const playlists = Array.isArray(body.playlists) ? body.playlists : null;
  const likedSongs = Array.isArray(body.likedSongs) ? body.likedSongs : null;
  if (!playlists || !likedSongs) {
    throw new LibraryError("`playlists` and `likedSongs` arrays are required.", 400);
  }
  if (playlists.length > MAX_PLAYLISTS_PER_USER) {
    throw new LibraryError(`Playlists are limited to ${MAX_PLAYLISTS_PER_USER} per account.`, 413);
  }
  if (likedSongs.length > MAX_LIKED_SONGS) {
    throw new LibraryError(`Liked songs are limited to ${MAX_LIKED_SONGS} per account.`, 413);
  }
  for (const playlist of playlists) {
    if (!playlist || typeof playlist !== "object") {
      throw new LibraryError("Each playlist must be an object.", 400);
    }
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (tracks.length > MAX_TRACKS_PER_PLAYLIST) {
      throw new LibraryError(`Playlists are limited to ${MAX_TRACKS_PER_PLAYLIST} tracks.`, 413);
    }
    for (const track of tracks) normalizeTrackInput(track);
  }
  const normalizedLikes = likedSongs.map(normalizeTrackInput);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)").run(
      userId,
    );
    db.prepare("DELETE FROM playlists WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM liked_songs WHERE user_id = ?").run(userId);

    let trackCount = 0;
    const now = Date.now();
    const insertPlaylist = db.prepare(
      `INSERT INTO playlists (id, user_id, name, description, artwork_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTrack = db.prepare(
      `INSERT INTO playlist_tracks
         (playlist_id, position, track_id, source, title, artist, album, artwork_url, duration_seconds, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLike = db.prepare(
      `INSERT INTO liked_songs
         (user_id, track_id, source, title, artist, album, artwork_url, duration_seconds, liked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const seenPlaylistIds = new Set<string>();
    for (const playlist of playlists) {
      const name = typeof playlist.name === "string" ? playlist.name.trim().slice(0, MAX_NAME_LENGTH) : "";
      if (!name) throw new LibraryError("Each playlist needs a name.", 400);
      let id = typeof playlist.id === "string" && playlist.id.trim() ? playlist.id.trim().slice(0, 256) : "";
      if (!id || seenPlaylistIds.has(id)) id = `pl-${crypto.randomUUID()}`;
      seenPlaylistIds.add(id);

      insertPlaylist.run(
        id,
        userId,
        name,
        optionalString(playlist.description, MAX_DESCRIPTION_LENGTH),
        optionalString(playlist.artworkUrl, 2048),
        now,
        now,
      );
      const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
      const seenTrackIds = new Set<string>();
      tracks.forEach((raw, index) => {
        const track = normalizeTrackInput(raw);
        if (seenTrackIds.has(track.id)) return;
        seenTrackIds.add(track.id);
        insertTrack.run(
          id,
          index,
          track.id,
          track.source,
          track.title,
          track.artist,
          track.album,
          track.artworkUrl,
          track.durationSeconds,
          now,
        );
        trackCount += 1;
      });
    }

    const seenLikes = new Set<string>();
    for (const track of normalizedLikes) {
      if (seenLikes.has(track.id)) continue;
      seenLikes.add(track.id);
      insertLike.run(
        userId,
        track.id,
        track.source,
        track.title,
        track.artist,
        track.album,
        track.artworkUrl,
        track.durationSeconds,
        now,
      );
    }

    db.exec("COMMIT");
    return { playlists: seenPlaylistIds.size, likedSongs: seenLikes.size, tracks: trackCount };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

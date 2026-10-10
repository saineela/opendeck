import crypto from "node:crypto";
import type { Db } from "../db.js";
import { logger } from "../logger.js";

/**
 * Per-user play history, fed by `GET /api/media/stream` — the single funnel
 * every play passes through, whether it came from the web app (session
 * cookie) or an external client using the HTTP API (bearer API key). Plays
 * made through the API are attributed to the key that requested them.
 */

export type PlaySource = "app" | "api";

export interface PlayRecordInput {
  userId: string;
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationSeconds?: number | null;
  source: PlaySource;
  apiKeyId?: string | null;
  playedAt?: number;
}

/**
 * Audio elements issue several ranged requests per play (seeking, buffering),
 * so a repeated play of the same track within this window is treated as the
 * same listen instead of a new history row.
 */
const DEDUPE_WINDOW_MS = 90_000;

export function recordPlay(db: Db, input: PlayRecordInput): boolean {
  const playedAt = input.playedAt ?? Date.now();
  const videoId = input.videoId.slice(0, 64);
  try {
    const recent = db
      .prepare(
        `SELECT id FROM play_history
         WHERE user_id = ? AND video_id = ? AND played_at > ?
         ORDER BY played_at DESC LIMIT 1`,
      )
      .get(input.userId, videoId, playedAt - DEDUPE_WINDOW_MS) as
      | { id: string }
      | undefined;
    if (recent) return false;

    db.prepare(
      `INSERT INTO play_history
         (id, user_id, video_id, title, artist, album, artwork_url, duration_seconds, source, api_key_id, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      input.userId,
      videoId,
      input.title.slice(0, 300) || videoId,
      (input.artist ?? "").slice(0, 200),
      input.album ? input.album.slice(0, 300) : null,
      input.artworkUrl ? input.artworkUrl.slice(0, 2048) : null,
      typeof input.durationSeconds === "number" && input.durationSeconds > 0
        ? Math.round(input.durationSeconds)
        : null,
      input.source,
      input.apiKeyId ?? null,
      playedAt,
    );
    return true;
  } catch (error) {
    // History is best-effort: never fail a stream because bookkeeping broke.
    logger.warn("playHistory.record failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface PlayHistoryItem {
  id: string;
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  source: PlaySource;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
  playedAt: number;
}

interface PlayRow {
  id: string;
  video_id: string;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  duration_seconds: number | null;
  source: string;
  api_key_id: string | null;
  api_key_label: string | null;
  played_at: number;
}

function toItem(row: PlayRow): PlayHistoryItem {
  return {
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    durationSeconds: row.duration_seconds,
    source: row.source === "api" ? "api" : "app",
    apiKeyId: row.api_key_id,
    apiKeyLabel: row.api_key_label,
    playedAt: row.played_at,
  };
}

export function listPlays(
  db: Db,
  userId: string,
  options: { limit: number; before?: number },
): { plays: PlayHistoryItem[]; hasMore: boolean } {
  const rows = db
    .prepare(
      `SELECT p.*, k.label AS api_key_label
       FROM play_history p LEFT JOIN api_keys k ON k.id = p.api_key_id
       WHERE p.user_id = ? AND (? IS NULL OR p.played_at < ?)
       ORDER BY p.played_at DESC
       LIMIT ?`,
    )
    .all(userId, options.before ?? null, options.before ?? null, options.limit + 1) as unknown as PlayRow[];
  const hasMore = rows.length > options.limit;
  return { plays: rows.slice(0, options.limit).map(toItem), hasMore };
}

export interface PlayStats {
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

export function getPlayStats(db: Db, userId: string): PlayStats {
  const now = Date.now();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total_plays,
              COALESCE(SUM(duration_seconds), 0) AS total_seconds,
              COALESCE(SUM(CASE WHEN played_at >= ? THEN 1 ELSE 0 END), 0) AS plays_today,
              COALESCE(SUM(CASE WHEN played_at >= ? THEN 1 ELSE 0 END), 0) AS plays_7d,
              COALESCE(SUM(CASE WHEN source = 'app' THEN 1 ELSE 0 END), 0) AS plays_app,
              COALESCE(SUM(CASE WHEN source = 'api' THEN 1 ELSE 0 END), 0) AS plays_api
       FROM play_history WHERE user_id = ?`,
    )
    .get(startOfDay.getTime(), now - 7 * 24 * 60 * 60 * 1000, userId) as {
    total_plays: number;
    total_seconds: number;
    plays_today: number;
    plays_7d: number;
    plays_app: number;
    plays_api: number;
  };

  const topTracks = (
    db
      .prepare(
        `SELECT video_id, title, artist, COUNT(*) AS plays, MAX(played_at) AS last_played_at
         FROM play_history WHERE user_id = ?
         GROUP BY video_id ORDER BY plays DESC, last_played_at DESC LIMIT 10`,
      )
      .all(userId) as Array<{
      video_id: string;
      title: string;
      artist: string;
      plays: number;
      last_played_at: number;
    }>
  ).map((row) => ({
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    plays: row.plays,
    lastPlayedAt: row.last_played_at,
  }));

  const topArtists = (
    db
      .prepare(
        `SELECT artist, COUNT(*) AS plays FROM play_history
         WHERE user_id = ? AND artist != ''
         GROUP BY artist ORDER BY plays DESC LIMIT 10`,
      )
      .all(userId) as Array<{ artist: string; plays: number }>
  ).map((row) => ({ artist: row.artist, plays: row.plays }));

  return {
    totalPlays: totals.total_plays,
    totalListeningSeconds: totals.total_seconds,
    playsToday: totals.plays_today,
    plays7d: totals.plays_7d,
    bySource: { app: totals.plays_app, api: totals.plays_api },
    topTracks,
    topArtists,
  };
}

export function clearPlays(db: Db, userId: string): number {
  const result = db.prepare("DELETE FROM play_history WHERE user_id = ?").run(userId);
  return Number(result.changes);
}

/** Per-API-key usage counters for the Settings → API key list. */
export function getKeyPlayStats(
  db: Db,
  userId: string,
): Map<string, { totalPlays: number; playsLast7Days: number; lastPlayedAt: number | null }> {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT k.id AS key_id,
              COUNT(p.id) AS total_plays,
              COALESCE(SUM(CASE WHEN p.played_at >= ? THEN 1 ELSE 0 END), 0) AS plays_7d,
              MAX(p.played_at) AS last_played_at
       FROM api_keys k LEFT JOIN play_history p ON p.api_key_id = k.id
       WHERE k.user_id = ?
       GROUP BY k.id`,
    )
    .all(now - 7 * 24 * 60 * 60 * 1000, userId) as Array<{
    key_id: string;
    total_plays: number;
    plays_7d: number;
    last_played_at: number | null;
  }>;
  return new Map(
    rows.map((row) => [
      row.key_id,
      {
        totalPlays: row.total_plays,
        playsLast7Days: row.plays_7d,
        lastPlayedAt: row.last_played_at,
      },
    ]),
  );
}

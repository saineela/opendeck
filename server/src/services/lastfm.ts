import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";

/**
 * Last.fm web-service integration — port of `src-tauri/src/lastfm.rs`.
 * The API key/secret live in server environment variables (the desktop app
 * embedded them in the binary; here they never reach the browser).
 */

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";

export interface LastFmSession {
  username: string;
  sessionKey: string;
}

export interface LastFmTrackInput {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
}

export interface LastFmScrobbleInput extends LastFmTrackInput {
  timestamp: number;
}

function md5(value: string): string {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function cleanMetadata(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

export function apiSignature(params: Record<string, string>, sharedSecret: string): string {
  const sortedKeys = Object.keys(params).sort();
  let payload = "";
  for (const key of sortedKeys) {
    payload += key;
    payload += params[key];
  }
  payload += sharedSecret;
  return md5(payload);
}

interface LastFmErrorEnvelope {
  error?: number;
  message?: string;
}

async function signedLastFmPost<T>(
  config: ServerConfig,
  params: Record<string, string>,
): Promise<T> {
  if (!config.lastfm.apiKey || !config.lastfm.apiSecret) {
    throw new Error("Last.fm is not configured on this server (LASTFM_API_KEY / LASTFM_API_SECRET).");
  }
  const withKey: Record<string, string> = { ...params, api_key: config.lastfm.apiKey };
  const signature = apiSignature(withKey, config.lastfm.apiSecret);
  const body = new URLSearchParams({ ...withKey, api_sig: signature, format: "json" });

  const response = await fetch(LASTFM_API_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as T & LastFmErrorEnvelope;
  if (!response.ok || typeof payload.error === "number") {
    throw new Error(
      payload.message ?? `Last.fm request failed with HTTP ${response.status}.`,
    );
  }
  return payload;
}

export async function getAuthToken(config: ServerConfig): Promise<string> {
  const response = await signedLastFmPost<{ token: string }>(config, {
    method: "auth.getToken",
  });
  if (!response.token) {
    throw new Error("Last.fm did not return an auth token.");
  }
  return response.token;
}

export async function exchangeAuthToken(
  config: ServerConfig,
  token: string,
): Promise<LastFmSession> {
  const response = await signedLastFmPost<{ session: { name: string; key: string } }>(config, {
    method: "auth.getSession",
    token,
  });
  if (!response.session?.name || !response.session?.key) {
    throw new Error("Last.fm session response is missing required fields.");
  }
  return { username: response.session.name, sessionKey: response.session.key };
}

export function loadLastFmSession(db: Db, userId: string): LastFmSession | null {
  const row = db.prepare(
    "SELECT session_key, username FROM lastfm_sessions WHERE user_id = ?",
  ).get(userId) as { session_key: string; username: string } | undefined;
  if (!row) return null;
  return { username: row.username, sessionKey: row.session_key };
}

export function saveLastFmSession(db: Db, userId: string, session: LastFmSession): void {
  db.prepare(
    `INSERT INTO lastfm_sessions (user_id, session_key, username, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       session_key = excluded.session_key,
       username = excluded.username,
       updated_at = excluded.updated_at`,
  ).run(userId, session.sessionKey, session.username, Date.now());
}

export function deleteLastFmSession(db: Db, userId: string): void {
  db.prepare("DELETE FROM lastfm_sessions WHERE user_id = ?").run(userId);
}

export async function updateNowPlaying(
  config: ServerConfig,
  session: LastFmSession,
  input: LastFmTrackInput,
): Promise<void> {
  const params: Record<string, string> = {
    method: "track.updateNowPlaying",
    sk: session.sessionKey,
    artist: cleanMetadata(input.artist),
    track: cleanMetadata(input.track),
  };
  const album = input.album ? cleanMetadata(input.album) : "";
  if (album) params.album = album;
  if (input.duration && input.duration > 0) params.duration = String(Math.round(input.duration));
  await signedLastFmPost(config, params);
}

export async function scrobble(
  config: ServerConfig,
  session: LastFmSession,
  input: LastFmScrobbleInput,
): Promise<void> {
  const params: Record<string, string> = {
    method: "track.scrobble",
    sk: session.sessionKey,
    "artist[0]": cleanMetadata(input.artist),
    "track[0]": cleanMetadata(input.track),
    "timestamp[0]": String(input.timestamp),
  };
  const album = input.album ? cleanMetadata(input.album) : "";
  if (album) params["album[0]"] = album;
  if (input.duration && input.duration > 0) {
    params["duration[0]"] = String(Math.round(input.duration));
  }
  await signedLastFmPost(config, params);
}

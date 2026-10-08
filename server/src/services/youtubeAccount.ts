import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { decryptJson, encryptJson } from "./tokenCipher.js";
import {
  refreshYouTubeTokens,
  revokeYouTubeToken,
  type YouTubeTokens,
} from "./youtubeOAuth.js";
import { logger } from "../logger.js";

interface TokenRow {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  expires_at: number | null;
  valid: number;
}

const EXPIRY_SKEW_MS = 60_000;

export function saveYouTubeTokens(
  db: Db,
  config: ServerConfig,
  userId: string,
  tokens: YouTubeTokens,
): void {
  const payload = encryptJson(config.appSecret, tokens);
  const expiresAt = Date.parse(tokens.expiry_date);
  db.prepare(
    `INSERT INTO youtube_tokens (user_id, ciphertext, nonce, auth_tag, expires_at, valid, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       nonce = excluded.nonce,
       auth_tag = excluded.auth_tag,
       expires_at = excluded.expires_at,
       valid = 1,
       updated_at = excluded.updated_at`,
  ).run(userId, payload.ciphertext, payload.nonce, payload.authTag, Number.isNaN(expiresAt) ? null : expiresAt, Date.now());
}

export function hasValidYouTubeLink(db: Db, userId: string): boolean {
  const row = db.prepare("SELECT valid FROM youtube_tokens WHERE user_id = ?").get(userId) as
    | { valid: number }
    | undefined;
  return Boolean(row && row.valid === 1);
}

export function clearYouTubeTokens(db: Db, userId: string): void {
  db.prepare("DELETE FROM youtube_tokens WHERE user_id = ?").run(userId);
}

function loadTokens(db: Db, config: ServerConfig, userId: string): YouTubeTokens | null {
  const row = db.prepare(
    "SELECT ciphertext, nonce, auth_tag, expires_at, valid FROM youtube_tokens WHERE user_id = ?",
  ).get(userId) as TokenRow | undefined;
  if (!row || row.valid !== 1) return null;
  try {
    return decryptJson<YouTubeTokens>(config.appSecret, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    });
  } catch (error) {
    logger.error("youtube.account token decryption failed", { error, userId });
    clearYouTubeTokens(db, userId);
    return null;
  }
}

function markInvalid(db: Db, userId: string): void {
  db.prepare("UPDATE youtube_tokens SET valid = 0, updated_at = ? WHERE user_id = ?").run(
    Date.now(),
    userId,
  );
}

/**
 * Returns a currently-valid YouTube OAuth access token for the user,
 * transparently refreshing it when expired. Returns null when the user has no
 * linked account or the refresh token no longer works.
 */
export async function getValidAccessToken(
  db: Db,
  config: ServerConfig,
  userId: string,
): Promise<string | null> {
  const tokens = loadTokens(db, config, userId);
  if (!tokens) return null;

  const expiry = Date.parse(tokens.expiry_date);
  if (!Number.isNaN(expiry) && Date.now() < expiry - EXPIRY_SKEW_MS) {
    return tokens.access_token;
  }

  try {
    const refreshed = await refreshYouTubeTokens(tokens);
    saveYouTubeTokens(db, config, userId, refreshed);
    return refreshed.access_token;
  } catch (error) {
    logger.warn("youtube.account token refresh failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid_grant|denied|revoked/i.test(message)) {
      markInvalid(db, userId);
    }
    // Return the stale token as a last resort; it may still work for a short window.
    return Number.isNaN(expiry) || Date.now() < expiry + 5 * 60_000
      ? tokens.access_token
      : null;
  }
}

export async function unlinkYouTubeAccount(
  db: Db,
  config: ServerConfig,
  userId: string,
): Promise<void> {
  const tokens = loadTokens(db, config, userId);
  if (tokens?.access_token) {
    await revokeYouTubeToken(tokens.access_token);
  }
  clearYouTubeTokens(db, userId);
}

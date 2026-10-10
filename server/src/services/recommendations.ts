import crypto from "node:crypto";
import webpush from "web-push";
import type { Db } from "../db.js";
import { logger } from "../logger.js";

/**
 * Song recommendations between registered OpenDeck accounts, with Web Push
 * delivery so the recipient is notified even when the app is closed.
 *
 * A recommendation snapshots the track metadata (video id, title, artist,
 * artwork) — the recipient's player resolves the stream itself, so the
 * recommendation keeps working when the sender's library changes. The whole
 * surface is plain JSON over session-cookie or bearer-API-key auth, so a
 * future mobile client can reuse it unchanged.
 */

export interface RecommendationInput {
  senderUserId: string;
  recipientUserId: string;
  videoId: string;
  title: string;
  artist?: string;
  album?: string | null;
  artworkUrl?: string | null;
  durationSeconds?: number | null;
  note?: string | null;
  createdAt?: number;
}

export interface RecommendationItem {
  id: string;
  senderUserId: string;
  senderName: string;
  recipientUserId: string;
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  note: string | null;
  createdAt: number;
  readAt: number | null;
}

interface RecommendationRow {
  id: string;
  sender_user_id: string;
  sender_name: string;
  recipient_user_id: string;
  video_id: string;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  duration_seconds: number | null;
  note: string | null;
  created_at: number;
  read_at: number | null;
}

function toItem(row: RecommendationRow): RecommendationItem {
  return {
    id: row.id,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name,
    recipientUserId: row.recipient_user_id,
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    durationSeconds: row.duration_seconds,
    note: row.note,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function sendRecommendation(db: Db, input: RecommendationInput): RecommendationItem {
  const id = crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO recommendations
       (id, sender_user_id, recipient_user_id, video_id, title, artist, album, artwork_url, duration_seconds, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.senderUserId,
    input.recipientUserId,
    input.videoId.slice(0, 64),
    input.title.slice(0, 300),
    (input.artist ?? "").slice(0, 200),
    input.album ? input.album.slice(0, 300) : null,
    input.artworkUrl ? input.artworkUrl.slice(0, 2048) : null,
    typeof input.durationSeconds === "number" && input.durationSeconds > 0
      ? Math.round(input.durationSeconds)
      : null,
    input.note ? input.note.slice(0, 500) : null,
    createdAt,
  );
  const row = db
    .prepare(
      `SELECT r.*, s.name AS sender_name
       FROM recommendations r JOIN users s ON s.id = r.sender_user_id
       WHERE r.id = ?`,
    )
    .get(id) as unknown as RecommendationRow;
  return toItem(row);
}

export function listRecommendations(
  db: Db,
  userId: string,
  options: { limit: number; unreadOnly?: boolean },
): { recommendations: RecommendationItem[]; unreadCount: number } {
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS sender_name
       FROM recommendations r JOIN users s ON s.id = r.sender_user_id
       WHERE r.recipient_user_id = ? ${options.unreadOnly ? "AND r.read_at IS NULL" : ""}
       ORDER BY r.created_at DESC
       LIMIT ?`,
    )
    .all(userId, options.limit) as unknown as RecommendationRow[];
  const unread = db
    .prepare("SELECT COUNT(*) AS n FROM recommendations WHERE recipient_user_id = ? AND read_at IS NULL")
    .get(userId) as { n: number };
  return { recommendations: rows.map(toItem), unreadCount: unread.n };
}

export function listSentRecommendations(db: Db, userId: string, limit: number): RecommendationItem[] {
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS sender_name
       FROM recommendations r JOIN users s ON s.id = r.sender_user_id
       WHERE r.sender_user_id = ?
       ORDER BY r.created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as unknown as RecommendationRow[];
  return rows.map(toItem);
}

/** Marks one recommendation read. Returns false when unknown or not the recipient. */
export function markRecommendationRead(db: Db, userId: string, id: string): boolean {
  const result = db
    .prepare("UPDATE recommendations SET read_at = ? WHERE id = ? AND recipient_user_id = ? AND read_at IS NULL")
    .run(Date.now(), id, userId);
  if (Number(result.changes) > 0) return true;
  // Already-read ids count as success (idempotent); unknown/foreign ids don't.
  const row = db
    .prepare("SELECT 1 AS hit FROM recommendations WHERE id = ? AND recipient_user_id = ?")
    .get(id, userId);
  return Boolean(row);
}

/** Deletes one recommendation; the sender may retract, the recipient may dismiss. */
export function deleteRecommendation(db: Db, userId: string, id: string): boolean {
  const result = db
    .prepare("DELETE FROM recommendations WHERE id = ? AND (sender_user_id = ? OR recipient_user_id = ?)")
    .run(id, userId, userId);
  return Number(result.changes) > 0;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  picture: string | null;
}

/** Registered accounts the signed-in user may recommend to (excludes self). */
export function listDirectory(db: Db, userId: string): DirectoryEntry[] {
  return db
    .prepare("SELECT id, name, picture FROM users WHERE id != ? ORDER BY name COLLATE NOCASE LIMIT 500")
    .all(userId) as unknown as DirectoryEntry[];
}

// --- Web Push ---------------------------------------------------------------

const VAPID_SUBJECT = "mailto:admin@opendeck.local";

function vapidKeysFromEnv(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

/**
 * VAPID identity for push delivery. Env vars win; otherwise a key pair is
 * generated once and persisted in `instance_config` so subscriptions keep
 * working across restarts.
 */
export function ensureVapidKeys(db: Db): { publicKey: string; privateKey: string } {
  const fromEnv = vapidKeysFromEnv();
  if (fromEnv) {
    webpush.setVapidDetails(VAPID_SUBJECT, fromEnv.publicKey, fromEnv.privateKey);
    return fromEnv;
  }
  const row = db
    .prepare("SELECT value FROM instance_config WHERE key = 'vapid_keys'")
    .get() as { value: string } | undefined;
  let keys: { publicKey: string; privateKey: string };
  if (row) {
    keys = JSON.parse(row.value);
  } else {
    keys = webpush.generateVAPIDKeys();
    db.prepare(
      "INSERT OR REPLACE INTO instance_config (key, value, updated_at) VALUES ('vapid_keys', ?, ?)",
    ).run(JSON.stringify(keys), Date.now());
    logger.info("push.vapid generated", { source: "instance_config" });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Upserts a per-device push subscription for the user. */
export function savePushSubscription(db: Db, userId: string, sub: PushSubscriptionInput): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       last_seen_at = excluded.last_seen_at`,
  ).run(crypto.randomUUID(), userId, sub.endpoint.slice(0, 2048), sub.keys.p256dh, sub.keys.auth, now, now);
}

export function removePushSubscription(db: Db, userId: string, endpoint: string): boolean {
  const result = db
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .run(endpoint, userId);
  return Number(result.changes) > 0;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, unknown>;
}

/**
 * Best-effort fan-out to every registered device of the user. Dead
 * subscriptions (404/410) are pruned; individual failures never fail the
 * recommendation that triggered them.
 */
export async function sendPushToUser(db: Db, userId: string, payload: PushPayload): Promise<void> {
  try {
    ensureVapidKeys(db);
  } catch (error) {
    logger.warn("push.vapid unavailable", { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const subs = db
    .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
    .all(userId) as unknown as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
          logger.info("push.subscription pruned", { id: sub.id, statusCode: status });
        } else {
          logger.warn("push.send failed", {
            id: sub.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );
}

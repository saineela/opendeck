import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    picture TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user_idx ON sessions(user_id);
  CREATE INDEX sessions_expires_idx ON sessions(expires_at);

  CREATE TABLE youtube_tokens (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    expires_at INTEGER,
    valid INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE lastfm_sessions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    username TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE cache_entries (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  );
  CREATE INDEX cache_last_used_idx ON cache_entries(last_used);

  CREATE TABLE app_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE server_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2 — multi-user accounts (email/password + TOTP) and per-user library.
  //
  // `users.google_sub` was NOT NULL, which cannot be relaxed with ALTER TABLE,
  // so the table is rebuilt. Password-only accounts have no Google subject.
  // The rebuild must run with foreign keys disabled (see openDatabase):
  // DROP TABLE would otherwise fire the ON DELETE CASCADE clauses declared by
  // sessions / youtube_tokens / app_settings.
  `
  CREATE TABLE users_v2 (
    id TEXT PRIMARY KEY,
    auth_provider TEXT NOT NULL DEFAULT 'google',
    google_sub TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    picture TEXT,
    password_hash TEXT,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_backup_codes TEXT NOT NULL DEFAULT '[]',
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );
  INSERT INTO users_v2
    (id, google_sub, name, email, picture, created_at, last_login_at)
    SELECT id, google_sub, name, email, picture, created_at, last_login_at FROM users;
  -- Keep the newest account when two legacy rows share an address: login
  -- lookup keys on email, so a duplicate would be ambiguous. Google logins
  -- still resolve on google_sub, so dropping the older address is lossless.
  UPDATE users_v2 SET email = NULL
   WHERE email IS NOT NULL
     AND id NOT IN (
       SELECT id FROM (SELECT id, MAX(created_at) FROM users_v2 WHERE email IS NOT NULL GROUP BY email)
     );
  DROP TABLE users;
  ALTER TABLE users_v2 RENAME TO users;
  CREATE UNIQUE INDEX users_email_uidx ON users(email) WHERE email IS NOT NULL;
  CREATE INDEX users_auth_provider_idx ON users(auth_provider);

  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    artwork_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_user_idx ON playlists(user_id, updated_at);

  CREATE TABLE playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'youtube',
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    artwork_url TEXT,
    duration_seconds INTEGER,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  );
  CREATE INDEX playlist_tracks_position_idx ON playlist_tracks(playlist_id, position);

  CREATE TABLE liked_songs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'youtube',
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    artwork_url TEXT,
    duration_seconds INTEGER,
    liked_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX liked_songs_recent_idx ON liked_songs(user_id, liked_at);
  `,
  // v3 — API keys (per-user programmatic access) and Last.fm removal.
  `
  DROP TABLE lastfm_sessions;

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX api_keys_user_idx ON api_keys(user_id);
  `,
  // v4 — roles, admin panel, and instance-level config (custom OIDC).
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

  CREATE TABLE instance_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v5 — per-user play history, including plays made through the HTTP API.
  // `api_key_id` attributes the play to the API key that requested the
  // stream; ON DELETE SET NULL keeps history when a key is revoked.
  `
  CREATE TABLE play_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    artwork_url TEXT,
    duration_seconds INTEGER,
    source TEXT NOT NULL DEFAULT 'app',
    api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX play_history_user_idx ON play_history(user_id, played_at DESC);
  CREATE INDEX play_history_key_idx ON play_history(api_key_id, played_at DESC);
  `,
  // v6 — song recommendations between registered accounts + Web Push
  // subscriptions. A recommendation snapshots the track metadata so the
  // recipient sees it even if the sender's library changes later; the
  // optional note is the sender's message. Push endpoints are per device.
  `
  CREATE TABLE recommendations (
    id TEXT PRIMARY KEY,
    sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    artwork_url TEXT,
    duration_seconds INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX recommendations_recipient_idx ON recommendations(recipient_user_id, created_at DESC);
  CREATE INDEX recommendations_sender_idx ON recommendations(sender_user_id, created_at DESC);

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
  `,
];

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current >= MIGRATIONS.length) return;
  db.exec("BEGIN");
  try {
    for (let index = current; index < MIGRATIONS.length; index += 1) {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec("COMMIT");
    logger.info("db.migrations applied", { from: current, to: MIGRATIONS.length });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Migrations run with FK enforcement off: v2 rebuilds `users`, and
  // DROP TABLE performs an implicit DELETE that would cascade away sessions,
  // YouTube tokens, Last.fm links, and per-user settings. The pragma is a
  // no-op inside a transaction, so it has to be flipped before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    migrate(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

export function getServerKv(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM server_kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setServerKv(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO server_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

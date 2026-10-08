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
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
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

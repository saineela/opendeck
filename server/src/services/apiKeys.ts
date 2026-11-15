import crypto from "node:crypto";
import type { Db } from "../db.js";

/**
 * Per-account API keys (`odk_…`), shared by the key-management routes and by
 * `POST /api/auth/token` — the password-to-key exchange a non-browser client
 * uses because it has nowhere to keep a session cookie.
 *
 * Only the SHA-256 hash is stored; the plaintext key exists in the response
 * that minted it and nowhere else.
 */

/** Keys per account. Past this, minting answers 429. */
export const MAX_API_KEYS_PER_USER = 25;

export interface MintedApiKey {
  id: string;
  label: string;
  /** Plaintext `odk_` + 43 URL-safe characters — returned exactly once. */
  key: string;
  keyPrefix: string;
  createdAt: number;
}

export function countApiKeys(db: Db, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function mintApiKey(db: Db, userId: string, label: string): MintedApiKey {
  const key = `odk_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, user_id, label, key_hash, key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, label, keyHash, key.slice(0, 12), now);
  return { id, label, key, keyPrefix: key.slice(0, 12), createdAt: now };
}

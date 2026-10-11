import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";

/**
 * Account helpers shared by the auth routes (self-service registration, OIDC
 * callback) and the admin routes (admin-created users): normalization and
 * role granting.
 *
 * Role rules:
 *  - the very first account on an instance becomes `admin` (first-run setup),
 *  - emails in `ADMIN_EMAILS` are granted `admin` at creation and re-asserted
 *    at every password sign-in,
 *  - everyone else is `user` until an admin promotes them.
 */

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  // Deliberately permissive: the only real validation is deliverability, and
  // over-strict regexes reject valid addresses. Require one @ with content
  // on both sides and no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return name || fallback;
}

export function userCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

/** Role for a brand-new account with the given (already normalized) email. */
export function grantRole(db: Db, email: string | null, config: ServerConfig): "admin" | "user" {
  if (userCount(db) === 0) return "admin";
  if (email && config.adminEmails.includes(email)) return "admin";
  return "user";
}

/**
 * Re-asserts the `ADMIN_EMAILS` policy for an existing account at sign-in,
 * so adding an address to the env list grants (and keeps) admin without a
 * manual role edit. Does not demote anyone.
 */
export function applyAdminEmailPolicy(
  db: Db,
  userId: string,
  email: string | null,
  config: ServerConfig,
): void {
  if (!email || config.adminEmails.length === 0) return;
  if (!config.adminEmails.includes(email.toLowerCase())) return;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role <> 'admin'").run(userId);
}

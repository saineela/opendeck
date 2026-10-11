import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";

/**
 * Instance-level configuration stored in SQLite (`instance_config`) so an
 * admin can change it at runtime from the admin panel — currently the custom
 * OIDC sign-in provider. Values override what `loadConfig` resolved from the
 * environment; an absent or empty row falls back to the env value.
 */

export interface OAuthProviderSettings {
  providerName: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  /** True when both client id and secret are present. */
  configured: boolean;
  /** Where the effective values came from. */
  source: "instance" | "env" | "none";
}

const OAUTH_KEYS = [
  "oauth.providerName",
  "oauth.clientId",
  "oauth.clientSecret",
  "oauth.discoveryUrl",
] as const;

function readOverrides(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT key, value FROM instance_config WHERE key IN (${OAUTH_KEYS.map(() => "?").join(", ")})`,
    )
    .all(...OAUTH_KEYS) as Array<{ key: string; value: string }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

function pick(overrides: Map<string, string>, key: string, envValue: string): string {
  if (!overrides.has(key)) return envValue;
  return overrides.get(key)!.trim();
}

/** Effective OIDC provider settings: instance_config overrides, else env. */
export function getOAuthSettings(db: Db, config: ServerConfig): OAuthProviderSettings {
  const overrides = readOverrides(db);
  const providerName = pick(overrides, "oauth.providerName", config.google.providerName);
  const clientId = pick(overrides, "oauth.clientId", config.google.clientId);
  const clientSecret = pick(overrides, "oauth.clientSecret", config.google.clientSecret);
  const discoveryUrl = pick(overrides, "oauth.discoveryUrl", config.google.discoveryUrl);
  const configured = Boolean(clientId && clientSecret);
  return {
    providerName: providerName || "Google",
    clientId,
    clientSecret,
    discoveryUrl,
    configured,
    source: overrides.size > 0 ? "instance" : configured ? "env" : "none",
  };
}

/**
 * A `ServerConfig` whose `google` block reflects the effective provider
 * settings — pass this to the OIDC service functions so runtime overrides
 * apply to the authorize/exchange/verify flow.
 */
export function withOAuthSettings(db: Db, config: ServerConfig): ServerConfig {
  const oauth = getOAuthSettings(db, config);
  return {
    ...config,
    google: {
      ...config.google,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      discoveryUrl: oauth.discoveryUrl,
      providerName: oauth.providerName,
      configured: oauth.configured,
    },
  };
}

export interface OAuthSettingsInput {
  providerName?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Persists provider overrides. An empty string deletes that override so the
 * env value applies again (send only the keys that changed).
 */
export function setOAuthSettings(db: Db, input: OAuthSettingsInput): void {
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO instance_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM instance_config WHERE key = ?");
  const apply = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (value.trim() === "") {
      remove.run(key);
      return;
    }
    upsert.run(key, value.trim(), now);
  };
  apply("oauth.providerName", input.providerName);
  apply("oauth.clientId", input.clientId);
  apply("oauth.clientSecret", input.clientSecret);
  apply("oauth.discoveryUrl", input.discoveryUrl);
}

/* ---------------------------------------------------------------------- *
 * Public account creation (registration) — admin-controlled at runtime.
 * ---------------------------------------------------------------------- */

const REGISTRATION_KEY = "registration.enabled";

export interface RegistrationSettings {
  /** Effective value: instance override, else the env-derived config. */
  enabled: boolean;
  /** True once an admin has flipped the switch away from the env default. */
  overridden: boolean;
}

/**
 * Effective registration switch. The env value (`ALLOW_REGISTRATION`) is the
 * baseline; an admin's panel toggle overrides it at runtime. The first-run
 * setup exemption (instance with zero accounts) is applied by the auth
 * routes on top of this — closing registration must never lock a fresh
 * instance out of creating its first admin.
 */
export function getRegistrationSettings(
  db: Db,
  config: ServerConfig,
): RegistrationSettings {
  const row = db
    .prepare("SELECT value FROM instance_config WHERE key = ?")
    .get(REGISTRATION_KEY) as { value: string } | undefined;
  if (!row) return { enabled: config.registration.enabled, overridden: false };
  return { enabled: row.value === "1", overridden: true };
}

/** Persists the admin's registration switch. */
export function setRegistrationEnabled(db: Db, enabled: boolean): void {
  db.prepare(
    `INSERT INTO instance_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(REGISTRATION_KEY, enabled ? "1" : "0", Date.now());
}

/* ---------------------------------------------------------------------- *
 * Instance theme — the admin's default look, served to everyone who has
 * not picked their own. The sign-in page has no signed-in user, so it can
 * only ever show this one; a personal override in app settings wins for
 * that account inside the app.
 * ---------------------------------------------------------------------- */

const INSTANCE_THEME_KEY = "theme.instance";

/** Themes the client knows about; the server only stores a string. */
export const KNOWN_INSTANCE_THEMES = new Set([
  "dark", "light", "glass", "matrix", "sakura", "tokyo",
  "ghibli", "cel", "sunset", "ocean", "nordic",
]);

/** Effective instance theme, or null when none is set (client default). */
export function getInstanceTheme(db: Db): string | null {
  const row = db
    .prepare("SELECT value FROM instance_config WHERE key = ?")
    .get(INSTANCE_THEME_KEY) as { value: string } | undefined;
  if (!row) return null;
  return KNOWN_INSTANCE_THEMES.has(row.value) ? row.value : null;
}

/** Persists the admin's instance theme. */
export function setInstanceTheme(db: Db, theme: string): void {
  db.prepare(
    `INSERT INTO instance_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(INSTANCE_THEME_KEY, theme, Date.now());
}

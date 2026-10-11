import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { destroyAllUserSessions, getSessionId, requireAdmin } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { checkPasswordPolicy, hashPassword } from "../services/password.js";
import { normalizeDisplayName, normalizeEmail } from "../services/accounts.js";
import {
  getInstanceTheme,
  getOAuthSettings,
  getRegistrationSettings,
  KNOWN_INSTANCE_THEMES,
  setInstanceTheme,
  setOAuthSettings,
  setRegistrationEnabled,
} from "../services/instanceConfig.js";
import { consumeBackupCode, verifyTotp } from "../services/totp.js";
import {
  clearImageCache,
  getImageCacheStats,
  listCachedImages,
} from "../services/imageCache.js";
import { logger } from "../logger.js";

/**
 * Admin panel API — role-based instance administration.
 *
 * Every route demands a real browser session whose account carries
 * `role = 'admin'` (`requireAdmin`): API keys are rejected so a leaked key
 * cannot administer the instance, and non-admins get 403. The destructive
 * instance reset additionally requires a fresh TOTP code (or backup code)
 * from the admin, so a hijacked logged-in admin session still cannot wipe
 * data.
 */
export function createAdminRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const adminGate = requireAdmin(db);
  const listLimit = rateLimit({ name: "admin-list", windowMs: 60_000, max: 60 });
  const mutateLimit = rateLimit({ name: "admin-mutate", windowMs: 60_000, max: 30 });
  const createLimit = rateLimit({ name: "admin-create", windowMs: 60_000, max: 10 });

  interface UserRow {
    id: string;
    name: string;
    email: string | null;
    role: string;
    auth_provider: string;
    totp_enabled: number;
    created_at: number;
    last_login_at: number;
  }

  const USER_COLUMNS =
    "id, name, email, role, auth_provider, totp_enabled, created_at, last_login_at";

  function toPublicUser(row: UserRow) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role === "admin" ? ("admin" as const) : ("user" as const),
      authProvider: row.auth_provider,
      totpEnabled: row.totp_enabled === 1,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }

  function findUser(id: unknown): UserRow | null {
    if (typeof id !== "string" || !id) return null;
    return (
      (db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined) ??
      null
    );
  }

  function countAdmins(): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
      n: number;
    };
    return row.n;
  }

  function jsonError(res: Response, status: number, error: string): void {
    res.status(status).json({ error });
  }

  /* ------------------------------------------------------------------ *
   * Overview + user management.
   * ------------------------------------------------------------------ */

  router.get("/overview", adminGate, listLimit, (_req: Request, res: Response) => {
    const count = (sql: string): number =>
      (db.prepare(sql).get() as { n: number }).n;
    res.json({
      users: count("SELECT COUNT(*) AS n FROM users"),
      admins: count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
      apiKeys: count("SELECT COUNT(*) AS n FROM api_keys"),
      cacheEntries: count("SELECT COUNT(*) AS n FROM cache_entries"),
      imageCacheBytes: getImageCacheStats(db).usedBytes,
      settings: count("SELECT COUNT(*) AS n FROM app_settings"),
    });
  });

  /* ------------------------------------------------------------------ *
   * Artwork cache administration — the "format disk" controls. The cache is
   * global, so the budget and the reset affect every account and both sit
   * behind the admin gate.
   * ------------------------------------------------------------------ */

  router.get("/image-cache", adminGate, listLimit, (_req: Request, res: Response) => {
    res.json({
      stats: getImageCacheStats(db),
      images: listCachedImages(db, 25),
    });
  });

  router.post("/image-cache/format", adminGate, mutateLimit, (req: Request, res: Response) => {
    const stats = clearImageCache(db);
    logger.warn("admin.imageCache.formatted", { adminId: req.sessionUserId });
    res.json({ ok: true, stats });
  });

  router.get("/users", adminGate, listLimit, (_req: Request, res: Response) => {
    const rows = db
      .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`)
      .all() as unknown as UserRow[];
    res.json({ users: rows.map(toPublicUser) });
  });

  /** Admin-created account: no invite code, optional role, immediate sign-in. */
  router.post("/users", adminGate, createLimit, async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      jsonError(res, 400, "Enter a valid email address.");
      return;
    }
    const policy = checkPasswordPolicy(req.body?.password);
    if (!policy.ok) {
      jsonError(res, 400, policy.error ?? "Invalid password.");
      return;
    }
    const role = req.body?.role ?? "user";
    if (role !== "admin" && role !== "user") {
      jsonError(res, 400, "Role must be \"admin\" or \"user\".");
      return;
    }
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      jsonError(res, 409, "An account with this email already exists.");
      return;
    }

    const passwordHash = await hashPassword(req.body.password as string);
    const now = Date.now();
    const id = crypto.randomUUID();
    const name = normalizeDisplayName(req.body?.name, email.split("@")[0] ?? "Listener");
    try {
      db.prepare(
        `INSERT INTO users
           (id, auth_provider, google_sub, name, email, picture, password_hash,
            totp_secret, totp_enabled, totp_backup_codes, failed_logins, locked_until,
            role, created_at, last_login_at)
         VALUES (?, 'password', NULL, ?, ?, NULL, ?, NULL, 0, '[]', 0, NULL, ?, ?, ?)`,
      ).run(id, name, email, passwordHash, role, now, now);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (typeof code === "string" && code.includes("UNIQUE")) {
        jsonError(res, 409, "An account with this email already exists.");
        return;
      }
      logger.error("admin.users.create failed", { error });
      jsonError(res, 500, "Unable to create the account.");
      return;
    }

    const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as unknown as UserRow;
    logger.info("admin.users.created", { adminId: req.sessionUserId, userId: id, role });
    res.status(201).json({ user: toPublicUser(row) });
  });

  router.patch("/users/:id", adminGate, mutateLimit, (req: Request, res: Response) => {
    const target = findUser(req.params.id);
    if (!target) {
      jsonError(res, 404, "User not found.");
      return;
    }
    const role = req.body?.role;
    if (role !== "admin" && role !== "user") {
      jsonError(res, 400, "Role must be \"admin\" or \"user\".");
      return;
    }
    if (target.role === role) {
      const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(target.id) as unknown as UserRow;
      res.json({ user: toPublicUser(row) });
      return;
    }
    if (target.id === req.sessionUserId) {
      jsonError(res, 400, "You cannot change your own role.");
      return;
    }
    if (target.role === "admin" && countAdmins() <= 1) {
      jsonError(res, 409, "This is the last administrator; promote someone else first.");
      return;
    }

    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, target.id);
    logger.info("admin.users.role", { adminId: req.sessionUserId, userId: target.id, role });
    const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(target.id) as unknown as UserRow;
    res.json({ user: toPublicUser(row) });
  });

  /** Force-sign-out everywhere (access revocation). */
  router.post("/users/:id/logout", adminGate, mutateLimit, (req: Request, res: Response) => {
    const target = findUser(req.params.id);
    if (!target) {
      jsonError(res, 404, "User not found.");
      return;
    }
    destroyAllUserSessions(db, target.id);
    logger.info("admin.users.sessionsRevoked", { adminId: req.sessionUserId, userId: target.id });
    res.json({ ok: true });
  });

  /** Clears a stuck/enrolled second factor (lockout recovery). */
  router.post("/users/:id/totp-reset", adminGate, mutateLimit, (req: Request, res: Response) => {
    const target = findUser(req.params.id);
    if (!target) {
      jsonError(res, 404, "User not found.");
      return;
    }
    if (target.id === req.sessionUserId) {
      jsonError(res, 400, "Use the Security section to change your own two-step verification.");
      return;
    }
    db.prepare(
      "UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = '[]' WHERE id = ?",
    ).run(target.id);
    destroyAllUserSessions(db, target.id);
    logger.info("admin.users.totpReset", { adminId: req.sessionUserId, userId: target.id });
    res.json({ ok: true });
  });

  router.delete("/users/:id", adminGate, mutateLimit, (req: Request, res: Response) => {
    const target = findUser(req.params.id);
    if (!target) {
      jsonError(res, 404, "User not found.");
      return;
    }
    if (target.id === req.sessionUserId) {
      jsonError(res, 400, "You cannot delete your own account.");
      return;
    }
    if (target.role === "admin" && countAdmins() <= 1) {
      jsonError(res, 409, "This is the last administrator; promote someone else first.");
      return;
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    logger.info("admin.users.deleted", { adminId: req.sessionUserId, userId: target.id });
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------------ *
   * Custom OIDC sign-in provider (instance_config overrides of the env).
   * ------------------------------------------------------------------ */

  function oauthPayload() {
    const settings = getOAuthSettings(db, config);
    return {
      provider: {
        providerName: settings.providerName,
        discoveryUrl: settings.discoveryUrl,
        clientId: settings.clientId,
        // Never echo the secret; only whether one is effective.
        clientSecretSet: Boolean(settings.clientSecret),
        configured: settings.configured,
        source: settings.source,
      },
    };
  }

  router.get("/oauth", adminGate, listLimit, (_req: Request, res: Response) => {
    res.json(oauthPayload());
  });

  router.put("/oauth", adminGate, mutateLimit, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: { providerName?: string; discoveryUrl?: string; clientId?: string; clientSecret?: string } = {};

    if (body.providerName !== undefined) {
      if (typeof body.providerName !== "string" || !body.providerName.trim() || body.providerName.trim().length > 40) {
        jsonError(res, 400, "Provider name must be 1-40 characters.");
        return;
      }
      input.providerName = body.providerName;
    }
    if (body.discoveryUrl !== undefined) {
      if (typeof body.discoveryUrl !== "string") {
        jsonError(res, 400, "Discovery URL must be a string.");
        return;
      }
      const trimmed = body.discoveryUrl.trim();
      if (trimmed) {
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          jsonError(res, 400, "Discovery URL must be a valid URL.");
          return;
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          jsonError(res, 400, "Discovery URL must be http(s).");
          return;
        }
      }
      input.discoveryUrl = trimmed;
    }
    for (const key of ["clientId", "clientSecret"] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 1024) {
        jsonError(res, 400, `${key === "clientId" ? "Client ID" : "Client secret"} must be a string of at most 1024 characters.`);
        return;
      }
      input[key] = value;
    }

    setOAuthSettings(db, input);
    logger.info("admin.oauth.updated", {
      adminId: req.sessionUserId,
      fields: Object.keys(input),
    });
    res.json(oauthPayload());
  });

  /* ------------------------------------------------------------------ *
   * Public account creation — runtime switch over ALLOW_REGISTRATION.
   * ------------------------------------------------------------------ */

  function registrationPayload() {
    const settings = getRegistrationSettings(db, config);
    return {
      registration: {
        enabled: settings.enabled,
        overridden: settings.overridden,
        envDefault: config.registration.enabled,
        inviteCodeRequired: Boolean(config.registration.inviteCode),
      },
    };
  }

  router.get("/registration", adminGate, listLimit, (_req: Request, res: Response) => {
    res.json(registrationPayload());
  });

  router.put("/registration", adminGate, mutateLimit, (req: Request, res: Response) => {
    const enabled = (req.body ?? {}) as Record<string, unknown>;
    if (typeof enabled.enabled !== "boolean") {
      jsonError(res, 400, "\"enabled\" must be true or false.");
      return;
    }
    setRegistrationEnabled(db, enabled.enabled);
    logger.info("admin.registration.updated", {
      adminId: req.sessionUserId,
      enabled: enabled.enabled,
    });
    res.json(registrationPayload());
  });

  /* ------------------------------------------------------------------ *
   * Instance theme — the admin's default look for every page, including
   * sign-in. Personal choices inside the app still win per account.
   * ------------------------------------------------------------------ */

  router.get("/instance-theme", adminGate, listLimit, (_req: Request, res: Response) => {
    res.json({ theme: getInstanceTheme(db) });
  });

  router.put("/instance-theme", adminGate, mutateLimit, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.theme !== "string" || !KNOWN_INSTANCE_THEMES.has(body.theme)) {
      jsonError(res, 400, "\"theme\" must be a known theme id.");
      return;
    }
    setInstanceTheme(db, body.theme);
    logger.info("admin.instance-theme.updated", {
      adminId: req.sessionUserId,
      theme: body.theme,
    });
    res.json({ theme: getInstanceTheme(db) });
  });

  /* ------------------------------------------------------------------ *
   * Instance data reset — TOTP re-authentication required.
   * ------------------------------------------------------------------ */

  router.post("/reset", adminGate, mutateLimit, (req: Request, res: Response) => {
    const adminId = req.sessionUserId!;
    const account = db
      .prepare("SELECT totp_secret, totp_enabled, totp_backup_codes FROM users WHERE id = ?")
      .get(adminId) as
      | { totp_secret: string | null; totp_enabled: number; totp_backup_codes: string }
      | undefined;
    if (!account || account.totp_enabled !== 1 || !account.totp_secret) {
      jsonError(
        res,
        403,
        "Enable two-step verification on your account first — it is required for this action.",
      );
      return;
    }

    const submitted = typeof req.body?.totpCode === "string" ? req.body.totpCode.trim() : "";
    const usingBackup = Boolean(submitted) && !/^\d{6}$/.test(submitted.replace(/\s+/g, ""));
    let passed = false;
    if (usingBackup) {
      const stored = JSON.parse(account.totp_backup_codes || "[]") as string[];
      const remaining = consumeBackupCode(stored, submitted);
      if (remaining) {
        passed = true;
        db.prepare("UPDATE users SET totp_backup_codes = ? WHERE id = ?").run(
          JSON.stringify(remaining),
          adminId,
        );
      }
    } else if (submitted) {
      passed = verifyTotp(account.totp_secret, submitted);
    }
    if (!passed) {
      jsonError(res, 403, "Invalid two-step verification code.");
      return;
    }

    // Wipe instance data but keep accounts: durable settings, cache bytes,
    // and every other session (the acting admin stays signed in).
    const settingsCleared = db.prepare("DELETE FROM app_settings").run().changes;
    const cacheCleared = db.prepare("DELETE FROM cache_entries").run().changes;
    // Artwork is public content, but a full reset should not leave the
    // instance's disk footprint behind either.
    const imageCacheCleared = getImageCacheStats(db).entryCount;
    clearImageCache(db);
    // Every session dies except the one proving the TOTP code right now —
    // the acting admin stays signed in, everyone else must sign in again.
    const currentSessionId = getSessionId(req);
    const sessionsRevoked = currentSessionId
      ? db.prepare("DELETE FROM sessions WHERE id <> ?").run(currentSessionId).changes
      : db.prepare("DELETE FROM sessions").run().changes;
    logger.warn("admin.reset", {
      adminId,
      settingsCleared,
      cacheCleared,
      imageCacheCleared,
      sessionsRevoked,
    });
    res.json({ ok: true, settingsCleared, cacheCleared, sessionsRevoked });
  });

  return router;
}

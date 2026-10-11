import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getDiscovery,
  verifyIdToken,
} from "../services/googleOAuth.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionId,
  requireAuth,
  requireSession,
  setSessionCookie,
} from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { hasValidYouTubeLink } from "../services/youtubeAccount.js";
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "../services/password.js";
import {
  applyAdminEmailPolicy,
  grantRole,
  normalizeDisplayName,
  normalizeEmail,
  userCount,
} from "../services/accounts.js";
import {
  getInstanceTheme,
  getOAuthSettings,
  getRegistrationSettings,
  withOAuthSettings,
} from "../services/instanceConfig.js";
import {
  buildOtpauthUri,
  consumeBackupCode,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  verifyTotp,
} from "../services/totp.js";
import { logger } from "../logger.js";

const OAUTH_COOKIE = "od_oauth";
/**
 * Marks the browser that opened a QR sign-in link (the phone). Set by
 * `/google/qr/open`, consumed by the callback so it knows NOT to mint a
 * session for this browser — the desktop that owns the attempt claims it
 * through `/google/qr/verify` instead.
 */
const QR_COOKIE = "od_qr_attempt";
const QR_ATTEMPT_TTL_MS = 10 * 60 * 1000;

// Account-lockout thresholds for password sign-in. Deliberately generous
// enough not to lock out a household sharing one NAT address, while still
// grinding a targeted online guess to a halt.
const MAX_FAILED_LOGINS = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/** Lifetime of the pre-TOTP challenge exchanged for a session. */
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
}

/**
 * Cross-device sign-in attempts (RFC 8628-style handoff around the normal
 * authorization-code flow): the desktop creates an attempt and shows its
 * link as a QR code, the phone completes the consent, and the desktop
 * claims the resulting identity with the high-entropy attempt id. In-memory
 * like the YouTube link poller — the server is single-process.
 */
interface QrAttempt {
  id: string;
  expiresAt: number;
  status: "pending" | "completed" | "consumed";
  userId?: string;
}

const qrAttempts = new Map<string, QrAttempt>();

function pruneQrAttempts(): void {
  const now = Date.now();
  for (const [id, attempt] of qrAttempts) {
    // Completed attempts linger briefly so a slow Verify click still lands.
    if (attempt.expiresAt + 60_000 < now) qrAttempts.delete(id);
  }
}

function signValue(config: ServerConfig, value: string): string {
  return `${value}.${crypto.createHmac("sha256", config.appSecret).update(value).digest("base64url")}`;
}

function verifySignedValue(config: ServerConfig, signed: string): string | null {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;
  const value = signed.slice(0, separator);
  const expected = signValue(config, value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function sanitizeReturnTo(returnTo: unknown): string {
  if (typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return "/";
}

function readCookie(req: Request, name: string): string | null {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!raw) return null;
  return decodeURIComponent(raw.slice(name.length + 1));
}

/** Landing page shown on the phone once it has finished the consent. */
const QR_DONE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>Signed in</title>
</head>
<body>
  <p><strong>Signed in on your computer.</strong></p>
  <p>You can close this window and go back to OpenDeck.</p>
</body>
</html>`;

const CALLBACK_SCRIPT = "/auth-callback.js";
// The HTML is served from /api/auth/google/callback, so the script src must
// include the mount prefix to actually resolve.
const CALLBACK_SCRIPT_SRC = "/api/auth/auth-callback.js";

const CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>Completing sign-in…</title>
  <script src="${CALLBACK_SCRIPT_SRC}" defer></script>
</head>
<body data-return-to="__RETURN_TO__">
  <p>Completing sign-in… you can close this window.</p>
  <p id="auth-error" hidden></p>
</body>
</html>`;

/**
 * Renders the callback page. The return target is charset-filtered so it can
 * be embedded in the inline script without any injection surface.
 */
function callbackHtml(returnTo: string): string {
  const safe = sanitizeReturnTo(returnTo).replace(/[^A-Za-z0-9\-._~/?=&%+#]/g, "");
  return CALLBACK_HTML.replace("__RETURN_TO__", safe);
}


/** `fail` messages are user-facing; never include internals. */
function jsonError(res: Response, status: number, error: string, extra?: Record<string, unknown>): void {
  res.status(status).json(extra ? { error, ...extra } : { error });
}

export function createAuthRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const googleStartLimit = rateLimit({ name: "google-start", windowMs: 60_000, max: 20 });
  const googleQrLimit = rateLimit({ name: "google-qr", windowMs: 60_000, max: 10 });
  const registerLimit = rateLimit({ name: "register", windowMs: 60_000, max: 5 });
  const loginLimit = rateLimit({ name: "login", windowMs: 60_000, max: 10 });
  const totpLimit = rateLimit({ name: "totp", windowMs: 60_000, max: 15 });

  interface AccountRow {
    id: string;
    auth_provider: string;
    name: string;
    email: string | null;
    picture: string | null;
    password_hash: string | null;
    totp_secret: string | null;
    totp_enabled: number;
    totp_backup_codes: string;
    failed_logins: number;
    locked_until: number | null;
  }

  function findAccountByEmail(email: string): AccountRow | null {
    return (
      (db.prepare("SELECT * FROM users WHERE email = ?").get(email) as AccountRow | undefined) ?? null
    );
  }

  function sessionPayload(req: Request) {
    const user = req.authUser ?? null;
    let totpEnabled = false;
    let authProvider: string | null = null;
    let role: "admin" | "user" | null = null;
    if (user) {
      const row = db
        .prepare("SELECT totp_enabled, auth_provider, role FROM users WHERE id = ?")
        .get(user.id) as { totp_enabled: number; auth_provider: string; role: string } | undefined;
      totpEnabled = row?.totp_enabled === 1;
      authProvider = row?.auth_provider ?? null;
      role = row?.role === "admin" ? "admin" : "user";
    }
    const oauth = getOAuthSettings(db, config);
    return {
      authenticated: Boolean(user),
      user: user
        ? { name: user.name, email: user.email, picture: user.picture }
        : null,
      youtubeLinked: user ? hasValidYouTubeLink(db, user.id) : false,
      totpEnabled,
      authProvider,
      role,
      /** True while the instance has no accounts: show first-run setup. */
      needsSetup: user ? false : userCount(db) === 0,
      passwordLoginEnabled: config.passwordLoginEnabled,
      // Public account creation: env baseline overridden by the admin
      // panel's runtime switch. The login page hides its "Create an
      // account" affordance when this is false.
      registrationEnabled: getRegistrationSettings(db, config).enabled,
      googleSignInEnabled: oauth.configured,
      oauthProvider: { name: oauth.providerName, configured: oauth.configured },
      inviteCodeRequired: Boolean(config.registration.inviteCode),
      // The admin's default theme. Public on purpose: the sign-in page has
      // no account behind it, and the instance's look is not a secret. A
      // signed-in user's own choice still wins inside the app.
      instanceTheme: getInstanceTheme(db),
    };
  }

  /** Issues a session and clears any lockout left over from the attempt. */
  function startSession(res: Response, userId: string): string {
    db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(userId);
    const account = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
      | { email: string | null }
      | undefined;
    applyAdminEmailPolicy(db, userId, account?.email ?? null, config);
    const sessionId = createSession(db, userId);
    setSessionCookie(res, config, sessionId);
    return sessionId;
  }

  router.get("/session", (req: Request, res: Response) => {
    res.json(sessionPayload(req));
  });

  /* ------------------------------------------------------------------
   * Local accounts: email + password (+ optional TOTP second factor).
   * ------------------------------------------------------------------ */

  router.post("/register", registerLimit, async (req: Request, res: Response) => {
    // First-run setup: while the instance has no accounts, registration
    // stays open (even with ALLOW_REGISTRATION=0 / INVITE_CODE set) so the
    // first person through creates the admin account.
    const needsSetup = userCount(db) === 0;
    const registration = getRegistrationSettings(db, config);
    if (!registration.enabled && !needsSetup) {
      jsonError(res, 403, "Registration is disabled on this server.");
      return;
    }
    if (config.registration.inviteCode && !needsSetup) {
      const supplied = typeof req.body?.inviteCode === "string" ? req.body.inviteCode.trim() : "";
      const expected = Buffer.from(config.registration.inviteCode, "utf8");
      const actual = Buffer.from(supplied, "utf8");
      const matches =
        actual.length === expected.length &&
        crypto.timingSafeEqual(
          actual.length === expected.length ? actual : Buffer.alloc(expected.length),
          expected,
        );
      if (!matches) {
        jsonError(res, 403, "A valid invite code is required.");
        return;
      }
    }

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
    if (findAccountByEmail(email)) {
      // Deliberately explicit rather than a generic "check your inbox": a
      // self-hosted instance has no email channel to fall back on, and the
      // endpoint is rate-limited to 5/min/IP which caps enumeration value.
      jsonError(res, 409, "An account with this email already exists.");
      return;
    }

    const passwordHash = await hashPassword(req.body.password as string);
    const now = Date.now();
    const id = crypto.randomUUID();
    const name = normalizeDisplayName(req.body?.name, email.split("@")[0] ?? "Listener");
    const role = grantRole(db, email, config);
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
      logger.error("auth.register failed", { error });
      jsonError(res, 500, "Unable to create the account.");
      return;
    }

    startSession(res, id);
    logger.info("auth.register success", { userId: id });
    res.status(201).json({ ok: true, user: { name, email, picture: null } });
  });

  /**
   * Step 1 of password sign-in. Returns a session directly, or — when the
   * account has TOTP enrolled — an opaque short-lived challenge that step 2
   * exchanges for the session. The password is never re-sent.
   */
  router.post("/login", loginLimit, async (req: Request, res: Response) => {
    if (!config.passwordLoginEnabled) {
      jsonError(res, 403, "Password sign-in is disabled on this server.");
      return;
    }
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    // The same generic failure for unknown address and wrong password.
    const generic = () => jsonError(res, 401, "Invalid email or password.");
    if (!email || !password) {
      generic();
      return;
    }

    const account = findAccountByEmail(email);
    if (!account || account.auth_provider !== "password") {
      await verifyPassword(password, null); // equalise timing
      generic();
      return;
    }

    const now = Date.now();
    if (account.locked_until && account.locked_until > now) {
      const retryAfter = Math.ceil((account.locked_until - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      jsonError(res, 429, "Too many failed attempts. Try again later.");
      return;
    }

    const ok = await verifyPassword(password, account.password_hash);
    if (!ok) {
      const failed = account.failed_logins + 1;
      const lockedUntil = failed >= MAX_FAILED_LOGINS ? now + LOCK_DURATION_MS : null;
      db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(
        failed,
        lockedUntil,
        account.id,
      );
      if (lockedUntil) {
        logger.warn("auth.login locked", { userId: account.id, failed });
        res.setHeader("Retry-After", String(Math.ceil(LOCK_DURATION_MS / 1000)));
        jsonError(res, 429, "Too many failed attempts. Try again in 15 minutes.");
        return;
      }
      generic();
      return;
    }

    if (account.totp_enabled === 1 && account.totp_secret) {
      const expiresAt = now + TOTP_CHALLENGE_TTL_MS;
      const nonce = crypto.randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO totp_login_challenges (nonce, user_id, expires_at) VALUES (?, ?, ?)")
        .run(nonce, account.id, expiresAt);
      db.prepare("DELETE FROM totp_login_challenges WHERE expires_at <= ?").run(now);
      const payload = `${account.id}:${expiresAt}:${nonce}`;
      res.json({
        status: "totp_required",
        challenge: signValue(config, payload),
        expiresInSeconds: Math.floor(TOTP_CHALLENGE_TTL_MS / 1000),
      });
      return;
    }

    startSession(res, account.id);
    logger.info("auth.login success", { userId: account.id });
    res.json({ status: "ok", user: { name: account.name, email: account.email, picture: account.picture } });
  });

  /** Step 2: completes a password sign-in that requires a TOTP code. */
  router.post("/login/totp", loginLimit, totpLimit, (req: Request, res: Response) => {
    if (!config.passwordLoginEnabled) {
      jsonError(res, 403, "Password sign-in is disabled on this server.");
      return;
    }
    const challenge = typeof req.body?.challenge === "string" ? req.body.challenge : "";
    const signed = challenge ? verifySignedValue(config, challenge) : null;
    const generic = () => jsonError(res, 401, "Invalid or expired code.");
    if (!signed) {
      generic();
      return;
    }
    const [userId, expiresAtRaw, nonce] = signed.split(":");
    const expiresAt = Number(expiresAtRaw);
    if (!userId || !Number.isFinite(expiresAt) || expiresAt < Date.now() || !nonce) {
      generic();
      return;
    }

    const submitted = req.body?.code;
    const usingBackup = typeof submitted === "string" && !/^\d{6}$/.test(submitted.replace(/\s+/g, ""));

    db.exec("BEGIN IMMEDIATE");
    let account: AccountRow;
    try {
      const currentAccount = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as AccountRow | undefined;
      if (!currentAccount || !currentAccount.totp_secret || currentAccount.totp_enabled !== 1) {
        db.exec("ROLLBACK");
        generic();
        return;
      }
      account = currentAccount;
      if (account.locked_until && account.locked_until > Date.now()) {
        db.exec("ROLLBACK");
        jsonError(res, 429, "Too many failed attempts. Try again later.");
        return;
      }

      const storedCodes = JSON.parse(account.totp_backup_codes || "[]") as string[];
      const remainingBackupCodes = usingBackup
        ? consumeBackupCode(storedCodes, submitted)
        : null;
      const passed = usingBackup
        ? remainingBackupCodes !== null
        : verifyTotp(currentAccount.totp_secret, submitted);

      if (!passed) {
        const failed = account.failed_logins + 1;
        const lockedUntil = failed >= MAX_FAILED_LOGINS ? Date.now() + LOCK_DURATION_MS : null;
        db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(
          failed,
          lockedUntil,
          account.id,
        );
        db.exec("COMMIT");
        generic();
        return;
      }

      const consumed = db.prepare(
        "DELETE FROM totp_login_challenges WHERE nonce = ? AND user_id = ? AND expires_at = ? AND expires_at > ?",
      ).run(nonce, account.id, expiresAt, Date.now());
      if (Number(consumed.changes) !== 1) {
        db.exec("ROLLBACK");
        generic();
        return;
      }

      db.prepare(
        "UPDATE users SET totp_backup_codes = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
      ).run(JSON.stringify(remainingBackupCodes ?? storedCodes), account.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    startSession(res, account.id);
    logger.info("auth.login.totp success", { userId: account.id, viaBackup: usingBackup });
    res.json({ status: "ok", user: { name: account.name, email: account.email, picture: account.picture } });
  });

  /* ------------------------------------------------------------------
   * TOTP enrolment / removal (session required throughout).
   * ------------------------------------------------------------------ */

  function requireLocalAccount(req: Request, res: Response): AccountRow | null {
    const userId = req.authUser?.id;
    if (!userId) {
      jsonError(res, 401, "Sign in is required.");
      return null;
    }
    const account = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as AccountRow | undefined;
    if (!account || account.auth_provider !== "password") {
      // Google accounts cannot carry a second factor of their own — their
      // session already depends on Google's authentication.
      jsonError(res, 400, "Two-step verification is only available for email and password accounts.");
      return null;
    }
    return account;
  }

  router.get("/totp/status", requireAuth, (req: Request, res: Response) => {
    const account = requireLocalAccount(req, res);
    if (!account) return;
    const enrolled = Boolean(account.totp_secret);
    res.json({
      enabled: account.totp_enabled === 1,
      enrolled,
      backupCodesRemaining: (JSON.parse(account.totp_backup_codes || "[]") as string[]).length,
    });
  });

  /**
   * Stores a pending secret (enabled only after the confirm step) so a user
   * cannot lock themselves out by scanning an unverified QR code.
   */
  router.post("/totp/setup", requireSession, totpLimit, (req: Request, res: Response) => {
    const account = requireLocalAccount(req, res);
    if (!account) return;
    if (account.totp_enabled === 1) {
      jsonError(res, 409, "Two-step verification is already enabled.");
      return;
    }
    const secret = generateTotpSecret();
    db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, account.id);
    res.json({
      secret,
      otpauthUri: buildOtpauthUri({
        secret,
        account: account.email ?? account.id,
        issuer: config.totpIssuer,
      }),
      issuer: config.totpIssuer,
      digits: 6,
      periodSeconds: 30,
    });
  });

  router.post("/totp/enable", requireSession, totpLimit, (req: Request, res: Response) => {
    const account = requireLocalAccount(req, res);
    if (!account) return;
    if (account.totp_enabled === 1) {
      jsonError(res, 409, "Two-step verification is already enabled.");
      return;
    }
    if (!account.totp_secret || !verifyTotp(account.totp_secret, req.body?.code)) {
      jsonError(res, 400, "That code is not valid. Check your authenticator app and try again.");
      return;
    }
    const codes = generateBackupCodes();
    db.prepare(
      "UPDATE users SET totp_enabled = 1, totp_backup_codes = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
    ).run(JSON.stringify(hashBackupCodes(codes)), account.id);
    logger.info("auth.totp.enabled", { userId: account.id });
    res.json({ enabled: true, backupCodes: codes });
  });

  router.post("/totp/disable", requireSession, totpLimit, async (req: Request, res: Response) => {
    const account = requireLocalAccount(req, res);
    if (!account) return;
    if (account.totp_enabled !== 1) {
      jsonError(res, 409, "Two-step verification is not enabled.");
      return;
    }
    // Re-authentication is required to remove the second factor: a stolen
    // session alone must not be enough to downgrade account security.
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const code = req.body?.code;
    const passwordOk = await verifyPassword(password, account.password_hash);
    const codeOk = Boolean(account.totp_secret && verifyTotp(account.totp_secret, code));
    if (!passwordOk || !codeOk) {
      jsonError(res, 400, "Password and current code are both required to turn off two-step verification.");
      return;
    }
    db.prepare(
      "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = '[]' WHERE id = ?",
    ).run(account.id);
    logger.info("auth.totp.disabled", { userId: account.id });
    res.json({ enabled: false });
  });

  /**
   * Arms the PKCE state cookie and returns the IdP authorize URL, or null
   * when no provider is configured. Shared by the popup/direct start route
   * and the QR handoff's phone-facing open route.
   */
  async function prepareAuthorize(res: Response, returnTo: unknown): Promise<string | null> {
    const oauthCfg = withOAuthSettings(db, config);
    if (!oauthCfg.google.configured) return null;
    const discovery = await getDiscovery(oauthCfg);
    const stateValue = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const oauthState: OAuthState = {
      state: stateValue,
      verifier,
      returnTo: sanitizeReturnTo(returnTo),
    };
    res.cookie(OAUTH_COOKIE, signValue(config, JSON.stringify(oauthState)), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.appUrl.startsWith("https://"),
      path: "/",
      maxAge: 10 * 60 * 1000,
    });
    return buildAuthorizeUrl(oauthCfg, discovery, {
      state: stateValue,
      codeChallenge: challenge,
      redirectUri: `${config.appUrl}/api/auth/google/callback`,
    });
  }

  router.get("/google/start", googleStartLimit, async (req: Request, res: Response) => {
    const oauthCfg = withOAuthSettings(db, config);
    if (!oauthCfg.google.configured) {
      res.status(503).json({
        error:
          "Sign-in is not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET (or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), or ask an administrator to configure it in Settings → Admin.",
      });
      return;
    }
    try {
      const authorizeUrl = await prepareAuthorize(res, req.query.returnTo);
      if (!authorizeUrl) {
        res.status(503).json({ error: "Sign-in is not configured on this server." });
        return;
      }
      res.redirect(authorizeUrl);
    } catch (error) {
      logger.error("auth.oauth.start failed", { error });
      res.status(502).json({ error: "Unable to start sign-in." });
    }
  });

  /* ------------------------------------------------------------------
   * Cross-device QR sign-in: the desktop shows a QR code, the phone
   * completes the consent, and the desktop claims the session with a
   * Verify button press. The phone never receives a session cookie.
   * ------------------------------------------------------------------ */

  router.post("/google/qr/start", googleQrLimit, (_req: Request, res: Response) => {
    const oauthCfg = withOAuthSettings(db, config);
    if (!oauthCfg.google.configured) {
      res.status(503).json({
        error:
          "Sign-in is not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET (or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), or ask an administrator to configure it in Settings → Admin.",
      });
      return;
    }
    pruneQrAttempts();
    const id = crypto.randomBytes(24).toString("base64url");
    qrAttempts.set(id, { id, expiresAt: Date.now() + QR_ATTEMPT_TTL_MS, status: "pending" });
    res.json({
      attemptId: id,
      qrUrl: `${config.appUrl}/api/auth/google/qr/open?attempt=${id}`,
      expiresInSec: QR_ATTEMPT_TTL_MS / 1000,
    });
    logger.info("auth.oauth.qr start", {});
  });

  /** Phone-facing: validates the attempt, then runs the normal consent hop. */
  router.get("/google/qr/open", googleStartLimit, async (req: Request, res: Response) => {
    const htmlError = (status: number, message: string) => {
      res.status(status).type("html").send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="robots" content="noindex" /><title>OpenDeck sign-in</title></head><body><p>${message.replace(/[<>&]/g, "")}</p></body></html>`,
      );
    };

    const attemptId = typeof req.query.attempt === "string" ? req.query.attempt : null;
    const attempt = attemptId ? qrAttempts.get(attemptId) : null;
    if (!attempt || attempt.status === "consumed") {
      htmlError(404, "This sign-in link is not valid. Go back to your computer and start again.");
      return;
    }
    if (attempt.status !== "pending" || attempt.expiresAt <= Date.now()) {
      htmlError(410, "This sign-in code has expired. Go back to your computer and get a new one.");
      return;
    }
    const oauthCfg = withOAuthSettings(db, config);
    if (!oauthCfg.google.configured) {
      htmlError(503, "Sign-in is not configured on this server.");
      return;
    }
    try {
      const authorizeUrl = await prepareAuthorize(res, "/");
      if (!authorizeUrl) {
        htmlError(503, "Sign-in is not configured on this server.");
        return;
      }
      // Narrow path so the marker can never influence a non-QR callback.
      res.cookie(QR_COOKIE, attempt.id, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https://"),
        path: "/api/auth",
        maxAge: QR_ATTEMPT_TTL_MS,
      });
      res.redirect(authorizeUrl);
    } catch (error) {
      logger.error("auth.oauth.qr.open failed", { error });
      htmlError(502, "Unable to start sign-in. Go back to your computer and try again.");
    }
  });

  /** Desktop-facing: the Verify button claims a completed attempt. */
  router.post("/google/qr/verify", googleQrLimit, (req: Request, res: Response) => {
    const attemptId = typeof req.body?.attemptId === "string" ? req.body.attemptId : null;
    if (!attemptId || attemptId.length > 128) {
      jsonError(res, 400, "A sign-in code is required.");
      return;
    }
    const attempt = qrAttempts.get(attemptId);
    if (!attempt || attempt.status === "consumed") {
      jsonError(
        res,
        attempt ? 409 : 404,
        attempt
          ? "This sign-in code was already used. Get a new one to sign in again."
          : "That sign-in code is no longer valid. Get a new one and try again.",
      );
      return;
    }
    if (attempt.expiresAt <= Date.now()) {
      jsonError(res, 410, "That sign-in code expired. Get a new one and try again.");
      return;
    }
    if (attempt.status === "pending") {
      res.json({ status: "pending" });
      return;
    }
    const userId = attempt.userId!;
    attempt.status = "consumed";
    startSession(res, userId);
    const user = db.prepare("SELECT name, email, picture FROM users WHERE id = ?").get(userId) as
      | { name: string; email: string | null; picture: string | null }
      | undefined;
    logger.info("auth.oauth.qr verified", { userId });
    res.json({
      status: "verified",
      user: { name: user?.name ?? "", email: user?.email ?? null, picture: user?.picture ?? null },
    });
  });

  router.get("/google/callback", async (req: Request, res: Response) => {
    const failure = (message: string) => {
      res.status(400).type("html").send(
        CALLBACK_HTML.replace("__RETURN_TO__", "/").replace(
          "<p id=\"auth-error\" hidden></p>",
          `<p id="auth-error">${message.replace(/[<>&]/g, "")}</p>`,
        ),
      );
    };

    const oauthCookie = readCookie(req, OAUTH_COOKIE);
    res.clearCookie(OAUTH_COOKIE, { path: "/" });
    if (!oauthCookie) {
      failure("Sign-in session expired. Please try again.");
      return;
    }
    const stored = verifySignedValue(config, oauthCookie);
    if (!stored) {
      failure("Sign-in session could not be verified.");
      return;
    }
    let oauthState: OAuthState;
    try {
      oauthState = JSON.parse(stored) as OAuthState;
    } catch {
      failure("Sign-in session is malformed.");
      return;
    }

    if (req.query.error) {
      failure("Sign-in was cancelled or refused.");
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state || state !== oauthState.state) {
      failure("Sign-in state mismatch.");
      return;
    }

    const oauthCfg = withOAuthSettings(db, config);
    if (!oauthCfg.google.configured) {
      failure("Sign-in is not configured on this server.");
      return;
    }

    try {
      const discovery = await getDiscovery(oauthCfg);
      const tokens = await exchangeCode(oauthCfg, discovery, {
        code,
        codeVerifier: oauthState.verifier,
        redirectUri: `${config.appUrl}/api/auth/google/callback`,
      });
      if (!tokens.id_token) {
        failure("The identity provider did not return an identity token.");
        return;
      }
      const profile = await verifyIdToken(oauthCfg, discovery, tokens.id_token);
      const now = Date.now();
      // Closed registration stops the IdP flow from minting NEW accounts too:
      // an unknown identity is refused, existing ones still sign in. First
      // run (no accounts) always stays open so the instance can be set up.
      const knownGoogleUser = profile.sub
        ? db.prepare("SELECT id FROM users WHERE google_sub = ?").get(profile.sub)
        : undefined;
      if (
        !knownGoogleUser
        && userCount(db) > 0
        && !getRegistrationSettings(db, config).enabled
      ) {
        failure("Registration is disabled on this server. Ask an administrator for an account.");
        return;
      }
      // Never bind an IdP identity onto an existing password account with
      // the same address: whoever controls that IdP account would inherit
      // the local one. The two stay separate and the user is told which
      // credential to use.
      if (profile.email) {
        const existing = db
          .prepare("SELECT auth_provider FROM users WHERE email = ?")
          .get(profile.email) as { auth_provider: string } | undefined;
        if (existing && existing.auth_provider === "password") {
          failure("An account with this email already uses a password. Sign in with your password instead.");
          return;
        }
      }
      const role = grantRole(db, profile.email ?? null, config);
      db.prepare(
        `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, role, created_at, last_login_at)
         VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(google_sub) DO UPDATE SET
           name = excluded.name,
           email = COALESCE(excluded.email, users.email),
           picture = COALESCE(excluded.picture, users.picture),
           last_login_at = excluded.last_login_at`,
      ).run(
        crypto.randomUUID(),
        profile.sub,
        profile.name,
        profile.email ?? null,
        profile.picture ?? null,
        role,
        now,
        now,
      );
      const user = db
        .prepare("SELECT id FROM users WHERE google_sub = ?")
        .get(profile.sub) as { id: string };
      applyAdminEmailPolicy(db, user.id, profile.email ?? null, config);

      // Cross-device (QR) handoff: this browser is the phone, so it gets a
      // confirmation page and NO session — the desktop that owns the attempt
      // claims the session through /google/qr/verify. Only a still-pending
      // attempt routes here; the direct/popup flow is unchanged.
      const qrAttemptId = readCookie(req, QR_COOKIE);
      res.clearCookie(QR_COOKIE, { path: "/api/auth" });
      const qrAttempt = qrAttemptId ? qrAttempts.get(qrAttemptId) : undefined;
      if (qrAttempt && qrAttempt.status === "pending" && qrAttempt.expiresAt > Date.now()) {
        qrAttempt.status = "completed";
        qrAttempt.userId = user.id;
        res.status(200).type("html").send(QR_DONE_HTML);
        logger.info("auth.oauth.qr completed on phone", { userId: user.id });
        return;
      }

      const sessionId = createSession(db, user.id);
      setSessionCookie(res, config, sessionId);
      res.status(200).type("html").send(callbackHtml(oauthState.returnTo));
      logger.info("auth.oauth.callback success", { userId: user.id });
    } catch (error) {
      logger.error("auth.oauth.callback failed", { error });
      failure("Sign-in failed. Please try again.");
    }
  });

  router.get(CALLBACK_SCRIPT, (_req: Request, res: Response) => {
    res.type("application/javascript").send(
      `(function(){
  var errEl = document.getElementById('auth-error');
  var failed = Boolean(errEl && !errEl.hidden);
  var payload = { odAuth: true, ok: !failed };
  var body = document.body;
  var returnTo = (body && body.getAttribute('data-return-to')) || '/';
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
      return;
    }
  } catch (e) { /* fall through to the no-opener path */ }
  if (failed) return;
  // No opener: COOP severed the link (cross-origin IdP hop) or this was a
  // top-level redirect. Close if the browser allows it; otherwise land
  // back inside the app instead of stranding the user on this page.
  try { window.close(); } catch (e) { /* ignore */ }
  setTimeout(function(){ window.location.replace(returnTo); }, 800);
})();`,
    );
  });

  router.post("/logout", (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    if (sessionId) destroySession(db, sessionId);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get("/whoami", requireAuth, (req: Request, res: Response) => {
    res.json(sessionPayload(req));
  });

  return router;
}

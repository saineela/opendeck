import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE } from "./middleware/session.js";
import { hashPassword } from "./services/password.js";
import {
  generateBackupCodes,
  generateTotpCode,
  generateTotpSecret,
  hashBackupCodes,
} from "./services/totp.js";

/**
 * Admin panel API: role-based access control, user management, the custom
 * OIDC provider config, and the TOTP-gated instance reset.
 *
 * Properties that matter: every route refuses anonymous callers (401) and
 * signed-in non-admins (403), an admin's API key is never enough (browser
 * session required), roles cannot be used to lock anyone out of the last
 * admin seat, the OAuth client secret is write-only, and the destructive
 * reset demands a fresh TOTP code while keeping the acting admin signed in.
 */

const GOOD_PASSWORD = "correct horse battery";

interface Ctx {
  db: Db;
  base: string;
  adminId: string;
  userId: string;
  adminCookie: string;
  userCookie: string;
  close: () => Promise<void>;
}

async function withApp(
  env: NodeJS.ProcessEnv,
  use: (ctx: Ctx) => Promise<void>,
  seed: { totp?: boolean } = {},
): Promise<void> {
  const config: ServerConfig = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "admin-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-admin-")),
    ...env,
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, password_hash,
                        totp_secret, totp_enabled, totp_backup_codes, failed_logins, locked_until,
                        role, created_at, last_login_at)
     VALUES (?, 'password', NULL, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
  );
  const adminId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const adminHash = await hashPassword(GOOD_PASSWORD);
  const userHash = await hashPassword(GOOD_PASSWORD);
  const adminSecret = seed.totp ? generateTotpSecret() : null;
  insert.run(
    adminId, "Ada Admin", "ada@example.com", adminHash,
    adminSecret, adminSecret ? 1 : 0, "[]", "admin", now, now,
  );
  insert.run(
    userId, "Uzi User", "user@example.com", userHash,
    null, 0, "[]", "user", now, now,
  );

  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: GOOD_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    return `${SESSION_COOKIE}=${raw.split(";")[0].slice(SESSION_COOKIE.length + 1)}`;
  };

  try {
    await use({
      db,
      base,
      adminId,
      userId,
      adminCookie: await login("ada@example.com"),
      userCookie: await login("user@example.com"),
      close: async () => {
        server.close();
        await once(server, "close");
        db.close();
      },
    });
  } finally {
    server.close();
    db.close();
  }
}

function call(
  ctx: Ctx,
  method: string,
  pathname: string,
  options: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${ctx.base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** A locally minted API key row for bearer-rejection tests. */
function insertApiKey(db: Db, userId: string): string {
  const key = `odk_${crypto.randomBytes(32).toString("base64url")}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  db.prepare(
    `INSERT INTO api_keys (id, user_id, label, key_hash, key_prefix, created_at)
     VALUES (?, ?, 'test', ?, ?, ?)`,
  ).run(crypto.randomUUID(), userId, hash, key.slice(0, 12), Date.now());
  return key;
}

describe("admin access control", () => {
  it("rejects anonymous callers on every route with 401", async () => {
    await withApp({}, async (ctx) => {
      for (const [method, path] of [
        ["GET", "/api/admin/overview"],
        ["GET", "/api/admin/users"],
        ["POST", "/api/admin/users"],
        ["GET", "/api/admin/oauth"],
        ["GET", "/api/admin/registration"],
        ["PUT", "/api/admin/registration"],
        ["POST", "/api/admin/reset"],
      ] as const) {
        const res = await call(ctx, method, path, { body: method === "GET" ? undefined : {} });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  it("rejects a signed-in non-admin with 403", async () => {
    await withApp({}, async (ctx) => {
      const res = await call(ctx, "GET", "/api/admin/users", { cookie: ctx.userCookie });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("Administrator");
    });
  });

  it("refuses an admin's API key — browser session only", async () => {
    await withApp({}, async (ctx) => {
      const key = insertApiKey(ctx.db, ctx.adminId);
      const res = await call(ctx, "GET", "/api/admin/users", { bearer: key });
      expect(res.status).toBe(401);
    });
  });
});

describe("overview and listing", () => {
  it("reports instance counts", async () => {
    await withApp({}, async (ctx) => {
      const res = await call(ctx, "GET", "/api/admin/overview", { cookie: ctx.adminCookie });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as Record<string, number>;
      expect(payload).toMatchObject({ users: 2, admins: 1, sessions: 2 });
    });
  });

  it("lists users with roles but never credential material", async () => {
    await withApp({}, async (ctx) => {
      const res = await call(ctx, "GET", "/api/admin/users", { cookie: ctx.adminCookie });
      expect(res.status).toBe(200);
      const { users } = (await res.json()) as {
        users: Array<{ id: string; email: string; role: string; totpEnabled: boolean }>;
      };
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.role).sort()).toEqual(["admin", "user"]);
      expect(users.find((u) => u.id === ctx.adminId)).toMatchObject({
        email: "ada@example.com",
        role: "admin",
      });
      const serialized = JSON.stringify(users);
      expect(serialized).not.toContain("password_hash");
      expect(serialized).not.toContain(GOOD_PASSWORD);
    });
  });
});

describe("creating users", () => {
  it("creates a password account that can sign in immediately", async () => {
    await withApp({}, async (ctx) => {
      const res = await call(ctx, "POST", "/api/admin/users", {
        cookie: ctx.adminCookie,
        body: { email: "new@example.com", password: "a good long password", name: "New Kid" },
      });
      expect(res.status).toBe(201);
      const { user } = (await res.json()) as { user: { role: string; email: string } };
      expect(user).toMatchObject({ email: "new@example.com", role: "user" });

      const login = await fetch(`${ctx.base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com", password: "a good long password" }),
      });
      expect(login.status).toBe(200);
      const body = (await login.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  it("rejects duplicates, weak passwords, and invalid roles", async () => {
    await withApp({}, async (ctx) => {
      const dupe = await call(ctx, "POST", "/api/admin/users", {
        cookie: ctx.adminCookie,
        body: { email: "user@example.com", password: GOOD_PASSWORD },
      });
      expect(dupe.status).toBe(409);

      const weak = await call(ctx, "POST", "/api/admin/users", {
        cookie: ctx.adminCookie,
        body: { email: "weak@example.com", password: "short" },
      });
      expect(weak.status).toBe(400);

      const badRole = await call(ctx, "POST", "/api/admin/users", {
        cookie: ctx.adminCookie,
        body: { email: "role@example.com", password: GOOD_PASSWORD, role: "superuser" },
      });
      expect(badRole.status).toBe(400);
    });
  });
});

describe("role management", () => {
  it("promotes and demotes other accounts, visible in their session", async () => {
    await withApp({}, async (ctx) => {
      const promote = await call(ctx, "PATCH", `/api/admin/users/${ctx.userId}`, {
        cookie: ctx.adminCookie,
        body: { role: "admin" },
      });
      expect(promote.status).toBe(200);
      expect(((await promote.json()) as { user: { role: string } }).user.role).toBe("admin");

      const theirSession = await call(ctx, "GET", "/api/auth/session", { cookie: ctx.userCookie });
      expect((await theirSession.json()) as Record<string, unknown>).toMatchObject({
        role: "admin",
      });

      const demote = await call(ctx, "PATCH", `/api/admin/users/${ctx.userId}`, {
        cookie: ctx.adminCookie,
        body: { role: "user" },
      });
      expect(demote.status).toBe(200);
      const back = await call(ctx, "GET", "/api/auth/session", { cookie: ctx.userCookie });
      expect((await back.json()) as Record<string, unknown>).toMatchObject({ role: "user" });
    });
  });

  it("refuses self-demotion, invalid roles, and unknown ids", async () => {
    await withApp({}, async (ctx) => {
      const self = await call(ctx, "PATCH", `/api/admin/users/${ctx.adminId}`, {
        cookie: ctx.adminCookie,
        body: { role: "user" },
      });
      expect(self.status).toBe(400);

      const bad = await call(ctx, "PATCH", `/api/admin/users/${ctx.userId}`, {
        cookie: ctx.adminCookie,
        body: { role: "root" },
      });
      expect(bad.status).toBe(400);

      const missing = await call(ctx, "PATCH", `/api/admin/users/${crypto.randomUUID()}`, {
        cookie: ctx.adminCookie,
        body: { role: "admin" },
      });
      expect(missing.status).toBe(404);
    });
  });
});

describe("access revocation", () => {
  it("signs a user out of every session", async () => {
    await withApp({}, async (ctx) => {
      const before = await call(ctx, "GET", "/api/auth/whoami", { cookie: ctx.userCookie });
      expect(before.status).toBe(200);

      const res = await call(ctx, "POST", `/api/admin/users/${ctx.userId}/logout`, {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(res.status).toBe(200);

      const after = await call(ctx, "GET", "/api/auth/whoami", { cookie: ctx.userCookie });
      expect(after.status).toBe(401);
    });
  });

  it("deletes a user, cascading sessions and API keys", async () => {
    await withApp({}, async (ctx) => {
      const key = insertApiKey(ctx.db, ctx.userId);

      const del = await call(ctx, "DELETE", `/api/admin/users/${ctx.userId}`, {
        cookie: ctx.adminCookie,
      });
      expect(del.status).toBe(200);

      const whoami = await call(ctx, "GET", "/api/auth/whoami", { cookie: ctx.userCookie });
      expect(whoami.status).toBe(401);
      const bearer = await call(ctx, "GET", "/api/auth/whoami", { bearer: key });
      expect(bearer.status).toBe(401);
      const list = await call(ctx, "GET", "/api/admin/users", { cookie: ctx.adminCookie });
      const { users } = (await list.json()) as { users: unknown[] };
      expect(users).toHaveLength(1);

      const self = await call(ctx, "DELETE", `/api/admin/users/${ctx.adminId}`, {
        cookie: ctx.adminCookie,
      });
      expect(self.status).toBe(400);
    });
  });

  it("clears a user's TOTP and revokes their sessions", async () => {
    await withApp({}, async (ctx) => {
      ctx.db
        .prepare(
          "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = '[]' WHERE id = ?",
        )
        .run(generateTotpSecret(), ctx.userId);
      expect(
        (
          await call(ctx, "GET", "/api/auth/totp/status", { cookie: ctx.userCookie })
        ).status,
      ).toBe(200);

      const res = await call(ctx, "POST", `/api/admin/users/${ctx.userId}/totp-reset`, {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(res.status).toBe(200);

      const row = ctx.db
        .prepare("SELECT totp_secret, totp_enabled FROM users WHERE id = ?")
        .get(ctx.userId) as { totp_secret: string | null; totp_enabled: number };
      expect(row.totp_secret).toBeNull();
      expect(row.totp_enabled).toBe(0);
      const after = await call(ctx, "GET", "/api/auth/totp/status", { cookie: ctx.userCookie });
      expect(after.status).toBe(401);

      const self = await call(ctx, "POST", `/api/admin/users/${ctx.adminId}/totp-reset`, {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(self.status).toBe(400);
    });
  });
});

describe("custom OIDC provider", () => {
  it("saves overrides without echoing the secret and reflects them in the session", async () => {
    await withApp({}, async (ctx) => {
      const initial = await call(ctx, "GET", "/api/admin/oauth", { cookie: ctx.adminCookie });
      expect((await initial.json()) as Record<string, unknown>).toMatchObject({
        provider: { providerName: "Google", configured: false, clientSecretSet: false, source: "none" },
      });

      const save = await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: {
          providerName: "Keycloak",
          discoveryUrl: "https://idp.example.com/realms/demo",
          clientId: "client-123",
          clientSecret: "super-secret-value",
        },
      });
      expect(save.status).toBe(200);
      const payload = (await save.json()) as { provider: Record<string, unknown> };
      expect(payload.provider).toMatchObject({
        providerName: "Keycloak",
        configured: true,
        clientSecretSet: true,
        source: "instance",
      });
      expect(JSON.stringify(payload)).not.toContain("super-secret-value");

      const reread = await call(ctx, "GET", "/api/admin/oauth", { cookie: ctx.adminCookie });
      expect(JSON.stringify(await reread.json())).not.toContain("super-secret-value");

      const session = await call(ctx, "GET", "/api/auth/session", { cookie: ctx.adminCookie });
      expect((await session.json()) as Record<string, unknown>).toMatchObject({
        googleSignInEnabled: true,
        oauthProvider: { name: "Keycloak", configured: true },
      });
    });
  });

  it("validates provider input and lets the secret be cleared", async () => {
    await withApp({}, async (ctx) => {
      const badUrl = await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: { discoveryUrl: "not-a-url" },
      });
      expect(badUrl.status).toBe(400);

      const badProto = await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: { discoveryUrl: "ftp://idp.example.com" },
      });
      expect(badProto.status).toBe(400);

      const emptyName = await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: { providerName: "   " },
      });
      expect(emptyName.status).toBe(400);

      await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: { clientId: "client-123", clientSecret: "s3cret" },
      });
      const cleared = await call(ctx, "PUT", "/api/admin/oauth", {
        cookie: ctx.adminCookie,
        body: { clientSecret: "" },
      });
      const payload = (await cleared.json()) as { provider: Record<string, unknown> };
      expect(payload.provider).toMatchObject({ configured: false, clientSecretSet: false });
    });
  });
});

describe("public account creation switch", () => {
  it("reports the env baseline and lets an admin close and reopen sign-up", async () => {
    await withApp({}, async (ctx) => {
      const initial = await call(ctx, "GET", "/api/admin/registration", {
        cookie: ctx.adminCookie,
      });
      expect(initial.status).toBe(200);
      const before = (await initial.json()) as { registration: Record<string, unknown> };
      // ALLOW_REGISTRATION unset → default open, no override yet.
      expect(before.registration).toMatchObject({
        enabled: true,
        overridden: false,
        envDefault: true,
      });

      const closed = await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.adminCookie,
        body: { enabled: false },
      });
      expect(closed.status).toBe(200);
      expect(((await closed.json()) as { registration: Record<string, unknown> }).registration)
        .toMatchObject({ enabled: false, overridden: true, envDefault: true });

      // Closed to the public: new sign-ups refused, session says so, but
      // existing accounts keep signing in.
      const signup = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "stranger@example.com", password: GOOD_PASSWORD },
      });
      expect(signup.status).toBe(403);
      expect(((await signup.json()) as { error: string }).error).toContain("disabled");

      const session = await call(ctx, "GET", "/api/auth/session");
      const payload = (await session.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        authenticated: false,
        registrationEnabled: false,
        needsSetup: false,
      });

      const returning = await call(ctx, "POST", "/api/auth/login", {
        body: { email: "user@example.com", password: GOOD_PASSWORD },
      });
      expect(returning.status).toBe(200);

      // Reopened: the same stranger can now register.
      await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.adminCookie,
        body: { enabled: true },
      });
      const retry = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "stranger@example.com", password: GOOD_PASSWORD },
      });
      expect(retry.status).toBe(201);
    });
  });

  it("validates the switch payload and refuses non-admins", async () => {
    await withApp({}, async (ctx) => {
      const bad = await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.adminCookie,
        body: { enabled: "yes" },
      });
      expect(bad.status).toBe(400);

      const missing = await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(missing.status).toBe(400);

      const forbidden = await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.userCookie,
        body: { enabled: false },
      });
      expect(forbidden.status).toBe(403);
    });
  });

  it("keeps first-run setup open on an empty instance even when closed", async () => {
    await withApp({}, async (ctx) => {
      // Close sign-up as the admin, then empty the instance entirely.
      await call(ctx, "PUT", "/api/admin/registration", {
        cookie: ctx.adminCookie,
        body: { enabled: false },
      });
      ctx.db.exec("DELETE FROM sessions; DELETE FROM users;");

      // The first-run exemption still lets the first admin be provisioned.
      const setup = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "first@example.com", password: GOOD_PASSWORD },
      });
      expect(setup.status).toBe(201);

      // …but the second account is refused again.
      const second = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "second@example.com", password: GOOD_PASSWORD },
      });
      expect(second.status).toBe(403);
    });
  });
});

describe("ADMIN_EMAILS", () => {
  it("grants admin to listed addresses at registration", async () => {
    await withApp({ ADMIN_EMAILS: "boss@example.com" }, async (ctx) => {
      const boss = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "boss@example.com", password: GOOD_PASSWORD },
      });
      expect(boss.status).toBe(201);
      expect((await boss.json()) as Record<string, unknown>).toMatchObject({ ok: true });

      const session = await call(ctx, "GET", "/api/auth/session", {
        cookie: `${SESSION_COOKIE}=${boss.headers.getSetCookie()[0]!.split(";")[0]!.slice(SESSION_COOKIE.length + 1)}`,
      });
      expect((await session.json()) as Record<string, unknown>).toMatchObject({ role: "admin" });

      const other = await call(ctx, "POST", "/api/auth/register", {
        body: { email: "pal@example.com", password: GOOD_PASSWORD },
      });
      expect(other.status).toBe(201);
      const otherSession = await call(ctx, "GET", "/api/auth/session", {
        cookie: `${SESSION_COOKIE}=${other.headers.getSetCookie()[0]!.split(";")[0]!.slice(SESSION_COOKIE.length + 1)}`,
      });
      expect((await otherSession.json()) as Record<string, unknown>).toMatchObject({
        role: "user",
      });
    });
  });

  it("upgrades an existing listed account at sign-in", async () => {
    await withApp({ ADMIN_EMAILS: "ada@example.com" }, async (ctx) => {
      // Seed made Ada an admin already; demote her to prove sign-in re-grants.
      ctx.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(ctx.adminId);
      const login = await fetch(`${ctx.base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com", password: GOOD_PASSWORD }),
      });
      expect(login.status).toBe(200);
      const raw = login.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
      const cookie = `${SESSION_COOKIE}=${raw.split(";")[0]!.slice(SESSION_COOKIE.length + 1)}`;
      const session = await call(ctx, "GET", "/api/auth/session", { cookie });
      expect((await session.json()) as Record<string, unknown>).toMatchObject({ role: "admin" });
    });
  });
});

describe("instance reset (TOTP re-authentication)", () => {
  it("requires two-step verification on the admin account", async () => {
    await withApp({}, async (ctx) => {
      const res = await call(ctx, "POST", "/api/admin/reset", {
        cookie: ctx.adminCookie,
        body: { totpCode: "123456" },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("two-step");
    });
  });

  it("rejects a missing or wrong code", async () => {
    await withApp({}, async (ctx) => {
      const secret = generateTotpSecret();
      ctx.db
        .prepare("UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?")
        .run(secret, ctx.adminId);

      const missing = await call(ctx, "POST", "/api/admin/reset", {
        cookie: ctx.adminCookie,
        body: {},
      });
      expect(missing.status).toBe(403);

      const wrong = await call(ctx, "POST", "/api/admin/reset", {
        cookie: ctx.adminCookie,
        body: { totpCode: "000000" },
      });
      expect(wrong.status).toBe(403);
      expect(((await wrong.json()) as { error: string }).error).toContain("Invalid");
    });
  });

  it("clears settings and cache, signing everyone else out but keeping the admin", async () => {
    await withApp({}, async (ctx, ) => {
      const secret = generateTotpSecret();
      ctx.db
        .prepare("UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?")
        .run(secret, ctx.adminId);
      ctx.db
        .prepare("INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)")
        .run(ctx.userId, "player", "{}", Date.now());
      ctx.db
        .prepare(
          "INSERT INTO cache_entries (namespace, key, value, bytes, last_used) VALUES (?, ?, ?, ?, ?)",
        )
        .run("user", "k", "v", 1, Date.now());

      const code = generateTotpCode(secret)!;
      const res = await call(ctx, "POST", "/api/admin/reset", {
        cookie: ctx.adminCookie,
        body: { totpCode: code },
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ ok: true, settingsCleared: 1, cacheCleared: 1 });
      expect(payload.sessionsRevoked as number).toBeGreaterThanOrEqual(1);

      expect(
        (ctx.db.prepare("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number }).n,
      ).toBe(0);
      expect(
        (ctx.db.prepare("SELECT COUNT(*) AS n FROM cache_entries").get() as { n: number }).n,
      ).toBe(0);

      const adminStillIn = await call(ctx, "GET", "/api/auth/whoami", { cookie: ctx.adminCookie });
      expect(adminStillIn.status).toBe(200);
      const userSignedOut = await call(ctx, "GET", "/api/auth/whoami", { cookie: ctx.userCookie });
      expect(userSignedOut.status).toBe(401);
    });
  });

  it("accepts a one-time backup code instead of a TOTP code", async () => {
    await withApp({}, async (ctx) => {
      const secret = generateTotpSecret();
      const backups = generateBackupCodes();
      ctx.db
        .prepare(
          "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?",
        )
        .run(secret, JSON.stringify(hashBackupCodes(backups)), ctx.adminId);

      const res = await call(ctx, "POST", "/api/admin/reset", {
        cookie: ctx.adminCookie,
        body: { totpCode: backups[0] },
      });
      expect(res.status).toBe(200);

      const remaining = ctx.db
        .prepare("SELECT totp_backup_codes FROM users WHERE id = ?")
        .get(ctx.adminId) as { totp_backup_codes: string };
      expect(JSON.parse(remaining.totp_backup_codes)).toHaveLength(backups.length - 1);
    });
  });
});

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
import { SESSION_COOKIE, createSession } from "./middleware/session.js";
import { generateTotpCode } from "./services/totp.js";

/**
 * Email + password accounts, TOTP enrolment, and lockout.
 *
 * These run against their own server instance so the in-memory rate-limit
 * buckets (5/min register, 10/min login) start empty for every case — the
 * main integration suite shares one app across all of its tests.
 */

const GOOD_PASSWORD = "correct horse battery";

interface Harness {
  db: Db;
  running: { base: string; close: () => Promise<void> };
}

async function withApp(env: NodeJS.ProcessEnv, use: (h: Harness) => Promise<void>): Promise<void> {
  const config: ServerConfig = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "local-auth-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-auth-")),
    ...env,
  });
  const db = openDatabase(":memory:");
  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await use({ db, running: { base: `http://127.0.0.1:${port}`, close: async () => {
      server.close();
      await once(server, "close");
    } } });
  } finally {
    server.close();
    db.close();
  }
}

function jsonPost(base: string, pathname: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function register(base: string, body: Record<string, unknown>): Promise<Response> {
  return jsonPost(base, "/api/auth/register", body);
}

function cookieHeader(res: Response, name = SESSION_COOKIE): string {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return `${name}=${decodeURIComponent(pair.slice(separator + 1))}`;
    }
  }
  return "";
}

describe("registration", () => {
  it("creates an account, issues a session cookie, and normalises the email", async () => {
    await withApp({}, async ({ running }) => {
      const res = await register(running.base, {
        email: "Alice@Example.com ",
        password: GOOD_PASSWORD,
        name: "Alice",
      });
      expect(res.status).toBe(201);
      const payload = (await res.json()) as { ok: boolean; user: { email: string; name: string } };
      expect(payload).toMatchObject({ ok: true, user: { email: "alice@example.com", name: "Alice" } });

      const setCookie = res.headers.getSetCookie().join(";");
      expect(setCookie).toContain("od_sid=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");

      const session = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: cookieHeader(res) },
      });
      expect(await session.json()).toMatchObject({
        authenticated: true,
        authProvider: "password",
        totpEnabled: false,
        user: { email: "alice@example.com", name: "Alice" },
      });
    });
  });

  it("rejects a duplicate registration without setting a cookie", async () => {
    await withApp({}, async ({ running }) => {
      await register(running.base, { email: "bob@example.com", password: GOOD_PASSWORD, name: "Bob" });
      const again = await register(running.base, { email: "bob@example.com", password: "another passphrase" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain("already exists");
      expect(again.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it("enforces the password policy and a valid email", async () => {
    await withApp({}, async ({ running, db }) => {
      const short = await register(running.base, { email: "carol@example.com", password: "short" });
      expect(short.status).toBe(400);
      expect(((await short.json()) as { error: string }).error).toContain("at least 8");

      const badEmail = await register(running.base, { email: "not-an-email", password: GOOD_PASSWORD });
      expect(badEmail.status).toBe(400);
      expect(((await badEmail.json()) as { error: string }).error).toContain("valid email");

      expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    });
  });

  it("rejects a cross-site registration attempt (CSRF)", async () => {
    await withApp({}, async ({ running }) => {
      const res = await fetch(`${running.base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: "x@example.com", password: GOOD_PASSWORD }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("Cross-site");
    });
  });
});

describe("registration controls", () => {
  it("keeps first-run setup open, then closes new sign-ups but allows password sign-in", async () => {
    await withApp({ ALLOW_REGISTRATION: "0" }, async ({ running }) => {
      const setup = await register(running.base, {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(setup.status).toBe(201);

      const denied = await register(running.base, { email: "x@example.com", password: GOOD_PASSWORD });
      expect(denied.status).toBe(403);

      const login = await jsonPost(running.base, "/api/auth/login", {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ status: "ok", user: { email: "owner@example.com" } });
    });
  });

  it("does not allow a runtime registration override to disable password login", async () => {
    await withApp({}, async ({ running }) => {
      const setup = await register(running.base, {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(setup.status).toBe(201);

      const registration = await fetch(`${running.base}/api/admin/registration`, {
        headers: { cookie: cookieHeader(setup) },
      });
      expect(registration.status).toBe(200);
      const updated = await fetch(`${running.base}/api/admin/registration`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: cookieHeader(setup) },
        body: JSON.stringify({ enabled: false }),
      });
      expect(updated.status).toBe(200);

      const denied = await register(running.base, { email: "x@example.com", password: GOOD_PASSWORD });
      expect(denied.status).toBe(403);
      const login = await jsonPost(running.base, "/api/auth/login", {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(login.status).toBe(200);
    });
  });

  it("allows the dedicated setting to disable password sign-in independently", async () => {
    await withApp({ PASSWORD_LOGIN_ENABLED: "0", ALLOW_REGISTRATION: "0" }, async ({ running }) => {
      const setup = await register(running.base, {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(setup.status).toBe(201);

      const login = await jsonPost(running.base, "/api/auth/login", {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(login.status).toBe(403);
      const totp = await jsonPost(running.base, "/api/auth/login/totp", {
        challenge: "forged.deadbeef",
        code: "123456",
      });
      expect(totp.status).toBe(403);
      const session = await fetch(`${running.base}/api/auth/session`);
      expect(await session.json()).toMatchObject({ passwordLoginEnabled: false, registrationEnabled: false });
    });
  });

  it("requires a matching invite code when one is configured", async () => {
    await withApp({ INVITE_CODE: "hunter2-please" }, async ({ running }) => {
      // First-run setup skips the invite code (there is nothing to invite
      // into yet).
      const setup = await register(running.base, {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(setup.status).toBe(201);

      const denied = await register(running.base, {
        email: "y@example.com",
        password: GOOD_PASSWORD,
        inviteCode: "nope",
      });
      expect(denied.status).toBe(403);

      const allowed = await register(running.base, {
        email: "y@example.com",
        password: GOOD_PASSWORD,
        inviteCode: "hunter2-please",
      });
      expect(allowed.status).toBe(201);
    });
  });

  it("makes the first account the admin and exposes setup state", async () => {
    await withApp({}, async ({ running }) => {
      const before = (await (await fetch(`${running.base}/api/auth/session`)).json()) as Record<
        string,
        unknown
      >;
      expect(before).toMatchObject({ authenticated: false, needsSetup: true, role: null });

      const first = await register(running.base, {
        email: "owner@example.com",
        password: GOOD_PASSWORD,
      });
      expect(first.status).toBe(201);

      // The instance is set up now: anonymous visitors see needsSetup false.
      const after = (await (await fetch(`${running.base}/api/auth/session`)).json()) as Record<
        string,
        unknown
      >;
      expect(after).toMatchObject({ authenticated: false, needsSetup: false });

      // The bootstrap account carries the admin role.
      const session = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: cookieHeader(first) },
      });
      expect(await session.json()).toMatchObject({
        authenticated: true,
        role: "admin",
        needsSetup: false,
      });

      // A second account is a regular user.
      const second = await register(running.base, {
        email: "friend@example.com",
        password: GOOD_PASSWORD,
      });
      expect(second.status).toBe(201);
      const secondSession = await fetch(`${running.base}/api/auth/session`, {
        headers: { cookie: cookieHeader(second) },
      });
      expect(await secondSession.json()).toMatchObject({ authenticated: true, role: "user" });
    });
  });
});

describe("password sign-in", () => {
  it("distinguishes nothing between an unknown account and a wrong password", async () => {
    await withApp({}, async ({ running }) => {
      await register(running.base, { email: "dave@example.com", password: GOOD_PASSWORD });

      const wrong = await jsonPost(running.base, "/api/auth/login", {
        email: "dave@example.com",
        password: "not the password",
      });
      expect(wrong.status).toBe(401);
      const wrongBody = (await wrong.json()) as { error: string };

      const unknown = await jsonPost(running.base, "/api/auth/login", {
        email: "nobody@example.com",
        password: "whatever it takes",
      });
      expect(unknown.status).toBe(401);
      expect((await unknown.json()) as { error: string }).toEqual(wrongBody);
      expect(unknown.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it("signs in with the correct password and starts a fresh session", async () => {
    await withApp({}, async ({ running }) => {
      await register(running.base, { email: "dave@example.com", password: GOOD_PASSWORD });
      const ok = await jsonPost(running.base, "/api/auth/login", {
        email: "dave@example.com",
        password: GOOD_PASSWORD,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: "ok", user: { email: "dave@example.com" } });
      expect(ok.headers.getSetCookie().join(";")).toContain("od_sid=");
    });
  });
});

describe("TOTP two-step verification", () => {
  it("enrols, challenges at sign-in, consumes backup codes once, and disables", async () => {
    await withApp({}, async ({ running, db }) => {
      const account = { email: "erin@example.com", password: GOOD_PASSWORD };
      const created = await register(running.base, account);
      expect(created.status).toBe(201);
      const cookie = cookieHeader(created);

      const initial = await fetch(`${running.base}/api/auth/totp/status`, { headers: { cookie } });
      expect(await initial.json()).toEqual({
        enabled: false,
        enrolled: false,
        backupCodesRemaining: 0,
      });

      const setup = await fetch(`${running.base}/api/auth/totp/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{}",
      });
      expect(setup.status).toBe(200);
      const enrollment = (await setup.json()) as { secret: string; otpauthUri: string };
      expect(enrollment.otpauthUri).toContain("otpauth://totp/OpenDeck:erin%40example.com");
      expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);

      // Not active until the first code proves the authenticator was scanned.
      const premature = await jsonPost(running.base, "/api/auth/totp/enable", { code: "000000" }, cookie);
      expect(premature.status).toBe(400);
      expect(premature.headers.getSetCookie()).toHaveLength(0);

      const enabled = await jsonPost(
        running.base,
        "/api/auth/totp/enable",
        { code: generateTotpCode(enrollment.secret) },
        cookie,
      );
      expect(enabled.status).toBe(200);
      const { backupCodes } = (await enabled.json()) as { backupCodes: string[] };
      expect(backupCodes).toHaveLength(10);
      expect(backupCodes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);

      // Password sign-in remains available when public registration is disabled.
      db.prepare("INSERT INTO instance_config (key, value, updated_at) VALUES ('registration.enabled', '0', ?)")
        .run(Date.now());

      // Password alone is no longer enough.
      const step1 = await jsonPost(running.base, "/api/auth/login", account);
      expect(step1.status).toBe(200);
      const challenge = (await step1.json()) as { status: string; challenge: string };
      expect(challenge.status).toBe("totp_required");

      const wrongCode = await jsonPost(running.base, "/api/auth/login/totp", {
        challenge: challenge.challenge,
        code: "000000",
      });
      expect(wrongCode.status).toBe(401);
      expect(wrongCode.headers.getSetCookie()).toHaveLength(0);

      const validCode = generateTotpCode(enrollment.secret);
      const concurrentAttempts = await Promise.all([
        jsonPost(running.base, "/api/auth/login/totp", {
          challenge: challenge.challenge,
          code: validCode,
        }),
        jsonPost(running.base, "/api/auth/login/totp", {
          challenge: challenge.challenge,
          code: validCode,
        }),
      ]);
      expect(concurrentAttempts.map((response) => response.status).sort()).toEqual([200, 401]);
      const successfulAttempt = concurrentAttempts.find((response) => response.status === 200);
      const rejectedReplay = concurrentAttempts.find((response) => response.status === 401);
      expect(successfulAttempt?.headers.getSetCookie().join(";")).toContain("od_sid=");
      expect(rejectedReplay?.headers.getSetCookie()).toHaveLength(0);

      // Backup codes remain single-use even when the user starts a fresh challenge.
      const backup = backupCodes[0]!;
      const backupChallenges = await Promise.all([0, 1].map(async () => {
        const login = await jsonPost(running.base, "/api/auth/login", account);
        expect(login.status).toBe(200);
        return (await login.json()) as { challenge: string };
      }));
      const backupAttempts = await Promise.all(backupChallenges.map(({ challenge: backupChallenge }) =>
        jsonPost(running.base, "/api/auth/login/totp", {
          challenge: backupChallenge,
          code: backup,
        }),
      ));
      expect(backupAttempts.map((response) => response.status).sort()).toEqual([200, 401]);

      const after = await fetch(`${running.base}/api/auth/totp/status`, { headers: { cookie } });
      expect(await after.json()).toMatchObject({ enabled: true, backupCodesRemaining: 9 });

      // Removing the factor requires re-authentication, not just the session.
      const noPassword = await jsonPost(running.base, "/api/auth/totp/disable", {}, cookie);
      expect(noPassword.status).toBe(400);
      const noCode = await jsonPost(
        running.base,
        "/api/auth/totp/disable",
        { password: account.password },
        cookie,
      );
      expect(noCode.status).toBe(400);

      const disabled = await jsonPost(
        running.base,
        "/api/auth/totp/disable",
        { password: account.password, code: generateTotpCode(enrollment.secret) },
        cookie,
      );
      expect(disabled.status).toBe(200);

      const row = db
        .prepare("SELECT totp_enabled, totp_secret, totp_backup_codes FROM users WHERE email = ?")
        .get(account.email) as { totp_enabled: number; totp_secret: string | null; totp_backup_codes: string };
      expect(row.totp_enabled).toBe(0);
      expect(row.totp_secret).toBeNull();
      expect(row.totp_backup_codes).toBe("[]");

      // Plain sign-in works again once the factor is gone.
      const plain = await jsonPost(running.base, "/api/auth/login", account);
      expect(plain.status).toBe(200);
      expect(((await plain.json()) as { status: string }).status).toBe("ok");
    });
  });

  it("rejects a forged challenge", async () => {
    await withApp({}, async ({ running }) => {
      const res = await jsonPost(running.base, "/api/auth/login/totp", {
        challenge: "forged.deadbeef",
        code: "123456",
      });
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it("is unavailable to Google-linked accounts", async () => {
    await withApp({}, async ({ running, db }) => {
      // Google accounts authenticate at their provider; a second local factor
      // would be security theatre, so the endpoint refuses instead.
      db.prepare(
        `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, created_at, last_login_at)
         VALUES ('g-1', 'google', 'sub-1', 'Googler', 'googler@example.com', NULL, ?, ?)`,
      ).run(Date.now(), Date.now());

      // Create the session directly — the point under test is the route
      // guard, not the OAuth dance that would normally issue it.
      const sid = createSession(db, "g-1");
      const status = await fetch(`${running.base}/api/auth/totp/status`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}` },
      });
      expect(status.status).toBe(400);
      expect(((await status.json()) as { error: string }).error).toContain("only available");
    });
  });
});

describe("account lockout", () => {
  it("resets the failure counter only after the TOTP challenge succeeds", async () => {
    await withApp({}, async ({ running, db }) => {
      const account = { email: "totp-reset@example.com", password: GOOD_PASSWORD };
      const created = await register(running.base, account);
      const cookie = cookieHeader(created);
      const setup = await fetch(`${running.base}/api/auth/totp/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{}",
      });
      const { secret } = (await setup.json()) as { secret: string };
      const enabled = await jsonPost(running.base, "/api/auth/totp/enable", {
        code: generateTotpCode(secret),
      }, cookie);
      expect(enabled.status).toBe(200);

      db.prepare("UPDATE users SET failed_logins = 7 WHERE email = ?").run(account.email);
      const passwordStep = await jsonPost(running.base, "/api/auth/login", account);
      expect(passwordStep.status).toBe(200);
      const { challenge } = (await passwordStep.json()) as { challenge: string };
      const afterPasswordStep = db.prepare("SELECT failed_logins FROM users WHERE email = ?")
        .get(account.email) as { failed_logins: number };
      expect(afterPasswordStep.failed_logins).toBe(7);

      const failedSecondFactor = await jsonPost(running.base, "/api/auth/login/totp", {
        challenge,
        code: "000000",
      });
      expect(failedSecondFactor.status).toBe(401);
      const afterFailedSecondFactor = db.prepare("SELECT failed_logins FROM users WHERE email = ?")
        .get(account.email) as { failed_logins: number };
      expect(afterFailedSecondFactor.failed_logins).toBe(8);

      const retry = await jsonPost(running.base, "/api/auth/login", account);
      expect(retry.status).toBe(200);
      const retryChallenge = (await retry.json()) as { challenge: string };
      const completed = await jsonPost(running.base, "/api/auth/login/totp", {
        challenge: retryChallenge.challenge,
        code: generateTotpCode(secret),
      });
      expect(completed.status).toBe(200);
      const afterCompleteSignIn = db.prepare("SELECT failed_logins, locked_until FROM users WHERE email = ?")
        .get(account.email) as { failed_logins: number; locked_until: number | null };
      expect(afterCompleteSignIn).toEqual({ failed_logins: 0, locked_until: null });
    });
  });

  it("locks on the tenth consecutive failure", async () => {
    await withApp({}, async ({ running, db }) => {
      const account = { email: "frank@example.com", password: GOOD_PASSWORD };
      await register(running.base, account);

      // Attempts 1-9 are ordinary rejections; the tenth trips the lock and
      // says so, which is more useful to a user who just mistyped nine times.
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        const res = await jsonPost(running.base, "/api/auth/login", {
          email: account.email,
          password: "wrong password",
        });
        expect(res.status, `attempt ${attempt}`).toBe(401);
      }
      const tripping = await jsonPost(running.base, "/api/auth/login", {
        email: account.email,
        password: "wrong password",
      });
      expect(tripping.status).toBe(429);
      expect(tripping.headers.get("retry-after")).toBeTruthy();

      const row = db
        .prepare("SELECT locked_until, failed_logins FROM users WHERE email = ?")
        .get(account.email) as { locked_until: number | null; failed_logins: number };
      expect(row.failed_logins).toBe(10);
      expect(row.locked_until).toBeGreaterThan(Date.now());
    });
  });

  it("refuses sign-in while locked, even with the correct password", async () => {
    await withApp({}, async ({ running, db }) => {
      const account = { email: "grace@example.com", password: GOOD_PASSWORD };
      await register(running.base, account);
      // Walk the counter to the brink so the next failure trips the lock.
      db.prepare("UPDATE users SET failed_logins = 9 WHERE email = ?").run(account.email);
      const trip = await jsonPost(running.base, "/api/auth/login", {
        email: account.email,
        password: "wrong password",
      });
      expect(trip.status).toBe(429);

      // Now the right password is refused for the duration of the lock.
      const blocked = await jsonPost(running.base, "/api/auth/login", account);
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toContain("failed attempts");
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(blocked.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it("clears the counter on a successful sign-in", async () => {
    await withApp({}, async ({ running, db }) => {
      const account = { email: "heidi@example.com", password: GOOD_PASSWORD };
      await register(running.base, account);
      db.prepare("UPDATE users SET failed_logins = 7 WHERE email = ?").run(account.email);

      const ok = await jsonPost(running.base, "/api/auth/login", account);
      expect(ok.status).toBe(200);
      const row = db
        .prepare("SELECT failed_logins, locked_until FROM users WHERE email = ?")
        .get(account.email) as { failed_logins: number; locked_until: number | null };
      expect(row.failed_logins).toBe(0);
      expect(row.locked_until).toBeNull();
    });
  });
});

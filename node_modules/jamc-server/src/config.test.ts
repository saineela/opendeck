import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jamac-config-"));
}

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
};

describe("loadConfig", () => {
  it("does not require Google credentials in production", () => {
    // Self-hosters can run on email + password alone; Google sign-in is an
    // optional extra rather than a deployment prerequisite.
    const config = loadConfig({
      NODE_ENV: "production",
      APP_SECRET: "a".repeat(40),
      DATA_DIR: tempDataDir(),
    });
    expect(config.google.configured).toBe(false);
    expect(config.registration.enabled).toBe(true);
  });

  it("requires APP_SECRET in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ...GOOGLE_ENV,
        DATA_DIR: tempDataDir(),
      }),
    ).toThrow(/APP_SECRET/);
  });

  it("rejects a short APP_SECRET in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ...GOOGLE_ENV,
        APP_SECRET: "too-short",
        DATA_DIR: tempDataDir(),
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("accepts a complete production configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ...GOOGLE_ENV,
      APP_SECRET: crypto.randomBytes(32).toString("hex"),
      DATA_DIR: tempDataDir(),
      APP_URL: "https://music.example.com",
    });
    expect(config.google.configured).toBe(true);
    expect(config.appUrl).toBe("https://music.example.com");
    expect(config.appSecret).toHaveLength(32);
  });

  it("generates and persists a development secret across reloads", () => {
    const dataDir = tempDataDir();
    const first = loadConfig({ NODE_ENV: "development", DATA_DIR: dataDir });
    const second = loadConfig({ NODE_ENV: "development", DATA_DIR: dataDir });
    expect(first.google.configured).toBe(false);
    expect(first.appSecret.equals(second.appSecret)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "dev-app-secret"))).toBe(true);
  });

  it("hashes a provided APP_SECRET deterministically to 32 bytes", () => {
    const env = { NODE_ENV: "test", APP_SECRET: "shared-secret-value", DATA_DIR: tempDataDir() };
    const first = loadConfig(env);
    const second = loadConfig(env);
    expect(first.appSecret).toHaveLength(32);
    expect(first.appSecret.equals(second.appSecret)).toBe(true);
  });

  it("parses scopes and flags", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_SECRET: "s".repeat(40),
      DATA_DIR: tempDataDir(),
      GOOGLE_OAUTH_SCOPES: "openid , email, ,profile",
      TRUST_PROXY: "1",
      SERVE_CLIENT: "0",
      PORT: "5173",
    });
    expect(config.google.scopes).toEqual(["openid", "email", "profile"]);
    expect(config.trustProxy).toBe(true);
    expect(config.serveClient).toBe(false);
    expect(config.port).toBe(5173);
    expect(config.appUrl).toBe("http://localhost:5173");
  });

  it("falls back to port 4000 for an absent, zero, or malformed PORT", () => {
    const base = {
      NODE_ENV: "test" as const,
      APP_SECRET: "s".repeat(40),
      DATA_DIR: tempDataDir(),
    };
    // PORT=0 (an OS-level default on some machines) would otherwise bind an
    // ephemeral port and derive a broken OAuth redirect URI.
    expect(loadConfig({ ...base, PORT: "0" }).port).toBe(4000);
    expect(loadConfig({ ...base, PORT: "0" }).appUrl).toBe("http://localhost:4000");
    expect(loadConfig({ ...base, PORT: "" }).port).toBe(4000);
    expect(loadConfig({ ...base, PORT: "not-a-port" }).port).toBe(4000);
    expect(loadConfig(base).port).toBe(4000);
  });
});

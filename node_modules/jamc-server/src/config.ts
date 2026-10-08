import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export interface ServerConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  appUrl: string;
  dataDir: string;
  dbPath: string;
  appSecret: Buffer;
  google: {
    clientId: string;
    clientSecret: string;
    discoveryUrl: string;
    scopes: string[];
    configured: boolean;
  };
  lastfm: {
    apiKey: string | null;
    apiSecret: string | null;
    configured: boolean;
  };
  trustProxy: boolean;
  serveClient: boolean;
}

function requireInProduction(env: NodeJS.ProcessEnv, key: string, nodeEnv: string): string | undefined {
  const value = env[key];
  if (value && value.trim()) return value.trim();
  if (nodeEnv === "production") {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and configure it.`,
    );
  }
  return undefined;
}

function resolveAppSecret(env: NodeJS.ProcessEnv, dataDir: string, nodeEnv: string): Buffer {
  const provided = env.APP_SECRET?.trim();
  if (provided) {
    if (provided.length < 32 && nodeEnv === "production") {
      throw new Error("APP_SECRET must be at least 32 characters in production.");
    }
    return crypto.createHash("sha256").update(provided).digest();
  }
  if (nodeEnv === "production") {
    throw new Error(
      "APP_SECRET is required in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  // Development/test fallback: persist a generated secret so sessions survive restarts.
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, "dev-app-secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return crypto.createHash("sha256").update(existing).digest();
  } catch {
    // Fall through to generation.
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return crypto.createHash("sha256").update(generated).digest();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development") as
    ServerConfig["nodeEnv"];
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(process.cwd(), ".data"));
  fs.mkdirSync(dataDir, { recursive: true });

  const googleClientId = requireInProduction(env, "GOOGLE_CLIENT_ID", nodeEnv) ?? "";
  const googleClientSecret = requireInProduction(env, "GOOGLE_CLIENT_SECRET", nodeEnv) ?? "";
  const scopes = (env.GOOGLE_OAUTH_SCOPES ?? "openid email profile")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    nodeEnv,
    port: Number(env.PORT ?? 4000),
    appUrl: (env.APP_URL ?? `http://localhost:${env.PORT ?? 4000}`).replace(/\/$/, ""),
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, "app.db"),
    appSecret: resolveAppSecret(env, dataDir, nodeEnv),
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      discoveryUrl: env.GOOGLE_OPENID_DISCOVERY
        ?? "https://accounts.google.com/.well-known/openid-configuration",
      scopes,
      configured: Boolean(googleClientId && googleClientSecret),
    },
    lastfm: {
      apiKey: env.LASTFM_API_KEY?.trim() || null,
      apiSecret: env.LASTFM_API_SECRET?.trim() || null,
      configured: Boolean(env.LASTFM_API_KEY?.trim() && env.LASTFM_API_SECRET?.trim()),
    },
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    serveClient: env.SERVE_CLIENT !== "0",
  };
}

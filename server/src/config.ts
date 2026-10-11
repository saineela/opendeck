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
    /** Display name for the OIDC button ("Google" unless overridden). */
    providerName: string;
  };
  /** Emails (lowercased) granted the admin role at sign-in. */
  adminEmails: string[];
  registration: {
    enabled: boolean;
    inviteCode: string | null;
  };
  /** Shown as the issuer in authenticator-app TOTP entries. */
  totpIssuer: string;
  trustProxy: boolean;
  serveClient: boolean;
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

/**
 * Resolves the listen port. An absent, empty, zero, or malformed PORT falls
 * back to 4000: an ephemeral port (0) would make the derived OAuth redirect
 * URI (`APP_URL`) wrong, so it is never a valid choice for this server.
 */
function resolvePort(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4000;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development") as
    ServerConfig["nodeEnv"];
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(process.cwd(), ".data"));
  fs.mkdirSync(dataDir, { recursive: true });

  // The OIDC provider is optional: a self-hosted instance can run entirely
  // on email + password accounts. OAUTH_* variables let you point sign-in at
  // any OIDC IdP (Keycloak, Authentik, …); GOOGLE_* remain as the legacy
  // names and are used when the OAUTH_* pair is absent. When nothing is
  // configured the sign-in surface hides the provider button (the session
  // payload reports `googleSignInEnabled` / `oauthProvider.configured`), and
  // an admin can override provider settings at runtime from the admin panel
  // (stored in instance_config; see services/instanceConfig.ts).
  const googleClientId = env.OAUTH_CLIENT_ID?.trim() || env.GOOGLE_CLIENT_ID?.trim() || "";
  const googleClientSecret = env.OAUTH_CLIENT_SECRET?.trim() || env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const scopes = (env.OAUTH_SCOPES ?? env.GOOGLE_OAUTH_SCOPES ?? "openid email profile")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const adminEmails = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  const port = resolvePort(env.PORT);

  return {
    nodeEnv,
    port,
    appUrl: (env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, "app.db"),
    appSecret: resolveAppSecret(env, dataDir, nodeEnv),
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      discoveryUrl: env.OAUTH_DISCOVERY ?? env.GOOGLE_OPENID_DISCOVERY
        ?? "https://accounts.google.com/.well-known/openid-configuration",
      scopes,
      configured: Boolean(googleClientId && googleClientSecret),
      providerName: env.OAUTH_PROVIDER_NAME?.trim() || "Google",
    },
    adminEmails,
    registration: {
      enabled: env.ALLOW_REGISTRATION !== "0" && env.ALLOW_REGISTRATION !== "false",
      inviteCode: env.INVITE_CODE?.trim() || null,
    },
    totpIssuer: env.TOTP_ISSUER?.trim() || "OpenDeck",
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    serveClient: env.SERVE_CLIENT !== "0",
  };
}

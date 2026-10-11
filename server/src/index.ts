import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";

// Optional .env loading. Values already present in the environment win, so
// process managers and the E2E harness stay authoritative. Two locations are
// probed: ./.env (working directory) and the webapp/ root one level above
// this package — both resolve identically for src/ (tsx) and dist/ (node).
// See .env.example.
try {
  process.loadEnvFile();
} catch {
  // No .env in the working directory.
}
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env at the webapp/ root either.
}

const config = loadConfig();

// Self-hosting sanity checks — misconfiguration here is silent until someone
// tries to sign in, so surface it at boot instead.
if (!config.google.configured && !config.passwordLoginEnabled) {
  logger.warn("server.no_sign_in_method", {
    hint: "Enable password sign-in (PASSWORD_LOGIN_ENABLED=1) or configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.",
  });
}
if (
  config.nodeEnv === "production"
  && (config.appUrl.includes("localhost") || config.appUrl.includes("127.0.0.1"))
) {
  logger.warn("server.app_url_is_localhost", {
    appUrl: config.appUrl,
    hint: "Set APP_URL to the public origin so OAuth redirects and Secure cookies work.",
  });
}

const db = openDatabase(config.dbPath);
const app = createApp(config, db);

const server = app.listen(config.port, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : config.port;
  logger.info("server.listening", {
    port: boundPort,
    requestedPort: config.port,
    appUrl: config.appUrl,
    nodeEnv: config.nodeEnv,
    googleConfigured: config.google.configured,
  });
});

function shutdown(signal: string): void {
  logger.info("server.shutdown", { signal });
  server.close(() => {
    try {
      db.close();
    } catch {
      // Database may already be closed.
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

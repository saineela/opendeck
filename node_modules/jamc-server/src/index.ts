import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp(config, db);

const server = app.listen(config.port, () => {
  logger.info("server.listening", {
    port: config.port,
    appUrl: config.appUrl,
    nodeEnv: config.nodeEnv,
    googleConfigured: config.google.configured,
    lastfmConfigured: config.lastfm.configured,
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

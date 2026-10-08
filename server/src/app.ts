import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import type { Db } from "./db.js";
import type { ServerConfig } from "./config.js";
import { sessionMiddleware } from "./middleware/session.js";
import { originCheck } from "./middleware/security.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createYoutubeAuthRoutes } from "./routes/youtubeAuth.js";
import { createProxyRoutes } from "./routes/proxy.js";
import { createCacheRoutes, createLastFmRoutes, createSettingsRoutes } from "./routes/data.js";
import { createMediaRoutes } from "./routes/media.js";
import { configureProxyHosts } from "./services/proxy.js";
import { logger } from "./logger.js";

function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../client/dist");
}

export function createApp(config: ServerConfig, db: Db): Express {
  configureProxyHosts(config);

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "https://www.youtube.com",
            // youtubei.js (the same engine the desktop app bundled) deciphers
            // YouTube player signatures by evaluating parsed player-script
            // fragments. The desktop app shipped with `"csp": null`; this is
            // the minimal allowance that keeps that logic working on the web.
            "'unsafe-eval'",
          ],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          mediaSrc: ["'self'", "blob:", "https:"],
          connectSrc: [
            "'self'",
            // BotGuard po-token attestation (bgutils-js) talks to Google's
            // WAA endpoint directly from the browser; without it resolved
            // stream URLs lack a `pot` parameter and googlevideo 403s.
            "https://jnn-pa.googleapis.com",
            "https://www.youtube.com",
          ],
          frameSrc: ["'self'", "https://www.youtube.com"],
          workerSrc: ["'self'", "blob:"],
          childSrc: ["'self'", "https://www.youtube.com"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  app.use(express.json({ limit: "10mb" }));
  app.use(originCheck(config));
  app.use(sessionMiddleware(db));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version: "1.0.0" });
  });

  app.use("/api/auth", createAuthRoutes(db, config));
  app.use("/api/youtube", createYoutubeAuthRoutes(db, config));
  app.use("/api/yt/proxy", createProxyRoutes(db, config));
  app.use("/api/cache", createCacheRoutes(db));
  app.use("/api/settings", createSettingsRoutes(db));
  app.use("/api/lastfm", createLastFmRoutes(db, config));
  app.use("/api/media", createMediaRoutes());

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found." });
  });

  if (config.serveClient) {
    const distDir = resolveClientDist();
    if (fs.existsSync(distDir)) {
      app.use(
        express.static(distDir, {
          index: false,
          maxAge: "1h",
          setHeaders: (res, filePath) => {
            if (filePath.includes(`${path.sep}assets${path.sep}`)) {
              res.setHeader("cache-control", "public, max-age=31536000, immutable");
            }
          },
        }),
      );
      app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    } else {
      logger.warn("server.client_dist_missing", {
        distDir,
        hint: "Run `npm run build` to produce the client bundle.",
      });
    }
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("server.unhandled_error", { error });
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

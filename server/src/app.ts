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
import { createCacheRoutes, createSettingsRoutes } from "./routes/data.js";
import { createArtworkRoutes } from "./routes/artwork.js";
import { createLibraryRoutes } from "./routes/library.js";
import { createFeedRoutes } from "./routes/feed.js";
import { createApiKeysRoutes } from "./routes/apiKeys.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createHistoryRoutes } from "./routes/history.js";
import { createMediaRoutes } from "./routes/media.js";
import { createRecommendationsRoutes, createPushRoutes } from "./routes/recommendations.js";
import { createPresenceRoutes } from "./routes/presence.js";
import { renderApiDocsPage } from "./services/apiDocs.js";
import { configureProxyHosts } from "./services/proxy.js";
import { configureDiscord } from "./services/discordRpc.js";
import { logger } from "./logger.js";

function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../client/dist");
}

function resolveApiMarkdown(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../docs/API.md");
}

/**
 * Companion documents the reference links to. Explicit allowlist, not a
 * directory read: `/docs/*` is public, so a path-traversal or an accidental
 * exposure of anything outside this list is the failure mode to avoid.
 */
const COMPANION_DOCS: Record<string, { title: string; markdown: boolean }> = {
  "INTEGRATION.md": { title: "OpenDeck — integration guide", markdown: true },
  "FEATURE_INVENTORY.md": { title: "OpenDeck — feature inventory", markdown: true },
  "openapi.yaml": { title: "OpenDeck — OpenAPI specification", markdown: false },
  ".env.example": { title: "OpenDeck — environment variables", markdown: false },
};

function resolveCompanionDoc(file: string): string | null {
  const entry = COMPANION_DOCS[file];
  if (!entry) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `.env.example` lives at the package root; the rest live in docs/.
  const base = file === ".env.example" ? path.resolve(here, "../..") : path.resolve(here, "../../docs");
  const resolved = path.resolve(base, file);
  // Defense in depth: never serve anything that escaped its base directory.
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

/** Plain-text companion (yaml, env) rendered as one readable page. */
function renderTextDocPage(title: string, content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px;
           background: #f6f8fb; color: #15171a; }
    header { border-bottom: 1px solid rgb(24 30 38 / 12%); background: #fff; padding: 18px 28px;
             display: flex; align-items: baseline; gap: 14px; }
    header .brand { font-weight: 700; }
    a { color: #d7193f; }
    main { max-width: 1000px; margin: 24px auto; padding: 0 24px; }
    pre { background: #0f1115; color: #e8e8ec; border-radius: 10px; padding: 18px;
          overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
    @media (prefers-color-scheme: dark) {
      body { background: #0a0b0e; color: #e9eaee; }
      header { background: #101216; border-bottom-color: rgb(255 255 255 / 10%); }
    }
  </style>
</head>
<body>
  <header><span class="brand">${title}</span><a href="/docs">← API reference</a></header>
  <main><pre>${escaped}</pre></main>
</body>
</html>`;
}

export function createApp(config: ServerConfig, db: Db): Express {
  configureProxyHosts(config);
  configureDiscord(config);

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);

  // Self-hosting usually means plain HTTP on a LAN address (http://192.168.x.y:4000),
  // and two helmet defaults actively break that deployment:
  //   * `upgrade-insecure-requests` makes the browser rewrite every subresource
  //     (the JS and CSS bundles) to https://<same-host>. Nothing answers on TLS,
  //     so both fail and the SPA paints an empty page behind an HTML title.
  //   * HSTS would pin the origin to HTTPS for a year on a host with no TLS
  //     listener, so the instance could not be reached again from that browser.
  // Enable them only when APP_URL says the instance really is served over TLS
  // (a domain behind a reverse proxy, or a TLS-terminating tunnel).
  const servedOverTls = config.appUrl.startsWith("https://");

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
          ...(servedOverTls ? {} : { upgradeInsecureRequests: null }),
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // See `servedOverTls` above: HSTS is meaningless (and harmful) over HTTP.
      ...(servedOverTls ? {} : { strictTransportSecurity: false }),
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
  app.use("/api/artwork", createArtworkRoutes(db));
  app.use("/api/cache", createCacheRoutes(db));
  app.use("/api/settings", createSettingsRoutes(db));
  app.use("/api/library", createLibraryRoutes(db));
  app.use("/api/history", createHistoryRoutes(db));
  app.use("/api/feed", createFeedRoutes(db, config));
  app.use("/api/keys", createApiKeysRoutes(db));
  app.use("/api/admin", createAdminRoutes(db, config));
  app.use("/api/media", createMediaRoutes(db));
  app.use("/api/recommendations", createRecommendationsRoutes(db));
  app.use("/api/push", createPushRoutes(db));
  app.use("/api/presence", createPresenceRoutes(db));

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found." });
  });

  // Rendered API reference (docs/API.md) — public on purpose: it documents
  // the interface, never instance data.
  app.get("/docs", (_req: Request, res: Response) => {
    try {
      const markdown = fs.readFileSync(resolveApiMarkdown(), "utf8");
      res.status(200).type("html").send(renderApiDocsPage(markdown));
    } catch (error) {
      logger.warn("docs.render failed", { error });
      res.status(500).json({ error: "Documentation is unavailable." });
    }
  });

  // Companion documents the reference links to (INTEGRATION.md, the OpenAPI
  // spec, …). Allowlisted above; unknown names 404 rather than falling through
  // to the SPA shell, so a typo is visible instead of silently rendering the
  // app inside the docs tab.
  app.get("/docs/:file", (req: Request, res: Response) => {
    // Express 5 types a route param as `string | string[]`; a repeated segment
    // is never a document name, so reject anything that is not a plain string
    // rather than casting and hoping.
    const file = req.params.file;
    if (typeof file !== "string") {
      res.status(404).json({ error: "No such document." });
      return;
    }
    const entry = COMPANION_DOCS[file];
    const resolved = resolveCompanionDoc(file);
    if (!entry || !resolved) {
      res.status(404).json({ error: "No such document." });
      return;
    }
    try {
      const content = fs.readFileSync(resolved, "utf8");
      res
        .status(200)
        .type("html")
        .send(entry.markdown ? renderApiDocsPage(content) : renderTextDocPage(entry.title, content));
    } catch (error) {
      logger.warn("docs.companion failed", { file, error });
      res.status(500).json({ error: "Documentation is unavailable." });
    }
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
    // body-parser failures (malformed/oversized/unsupported-charset JSON) are
    // client errors — surface their real status instead of a blanket 500.
    const bodyError = error as { type?: string; status?: number; statusCode?: number };
    if (typeof bodyError?.type === "string" && bodyError.type.startsWith("entity.")) {
      const status = bodyError.status ?? bodyError.statusCode ?? 400;
      res.status(status).json({
        error:
          bodyError.type === "entity.too.large"
            ? "Request body too large."
            : "Invalid JSON body.",
      });
      return;
    }
    logger.error("server.unhandled_error", { error });
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

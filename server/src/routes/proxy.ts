import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";
import { forwardProxyRequest, type ProxyRequestInput } from "../services/proxy.js";

function parseInput(body: unknown): ProxyRequestInput | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.length > 8192) return null;
  const headers: Record<string, string> = {};
  if (record.headers && typeof record.headers === "object") {
    for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value === "string" && key.length <= 256 && value.length <= 16384) {
        headers[key] = value;
      }
    }
  }
  if (record.body_base64 !== undefined && typeof record.body_base64 !== "string") return null;
  if (record.body_base64 && (record.body_base64 as string).length > 16 * 1024 * 1024) return null;
  return {
    url: record.url,
    method: typeof record.method === "string" ? record.method : "GET",
    headers,
    body_base64: typeof record.body_base64 === "string" ? record.body_base64 : undefined,
    timeout_ms: typeof record.timeout_ms === "number" ? record.timeout_ms : undefined,
  };
}

export function createProxyRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "yt-proxy", windowMs: 60_000, max: 900 });

  router.post("/", limiter, async (req: Request, res: Response) => {
    const input = parseInput(req.body);
    if (!input) {
      res.status(400).json({ error: "Invalid proxy request payload." });
      return;
    }
    const result = await forwardProxyRequest(db, config, input, req.sessionUserId ?? null);
    if (!result.ok) {
      logger.warn("proxy.rejected", {
        status: result.status,
        error: result.error,
        host: (() => {
          try {
            return new URL(input.url).hostname;
          } catch {
            return null;
          }
        })(),
        pathname: (() => {
          try {
            return new URL(input.url).pathname;
          } catch {
            return null;
          }
        })(),
      });
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.output);
  });

  return router;
}

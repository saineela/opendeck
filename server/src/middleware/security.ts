import type { RequestHandler } from "express";
import type { ServerConfig } from "../config.js";

/**
 * CSRF protection for cookie-authenticated mutations.
 *
 * Sessions ride on a SameSite=Lax cookie, which already blocks cross-site
 * form POSTs. As defense in depth we also reject requests whose Origin header
 * does not match our own origin, and reject anything the browser labels as
 * cross-site via Sec-Fetch-Site. Non-browser clients (tests, curl) send no
 * Origin/Sec-Fetch-Site headers and are allowed through.
 */
export function originCheck(config: ServerConfig): RequestHandler {
  const allowedOrigins = new Set<string>();
  try {
    allowedOrigins.add(new URL(config.appUrl).origin);
  } catch {
    // appUrl validated elsewhere; ignore.
  }

  return (req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      next();
      return;
    }

    const secFetchSite = req.headers["sec-fetch-site"];
    if (typeof secFetchSite === "string" && secFetchSite === "cross-site") {
      res.status(403).json({ error: "Cross-site request rejected." });
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).origin;
      } catch {
        res.status(403).json({ error: "Invalid Origin header." });
        return;
      }
      const host = req.headers.host;
      const selfOrigins = new Set(allowedOrigins);
      if (host) {
        const proto = req.protocol;
        selfOrigins.add(`${proto}://${host}`);
        selfOrigins.add(`http://${host}`);
        selfOrigins.add(`https://${host}`);
      }
      if (!selfOrigins.has(originHost)) {
        res.status(403).json({ error: "Cross-site request rejected." });
        return;
      }
    }
    next();
  };
}

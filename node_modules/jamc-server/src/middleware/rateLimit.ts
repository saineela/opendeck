import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal fixed-window in-memory rate limiter keyed by client IP + bucket
 * name. Suitable for a single-process deployment; swap for a shared store if
 * scaling horizontally.
 */
export function rateLimit(options: {
  name: string;
  windowMs: number;
  max: number;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > 5 * options.windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const key = `${options.name}:${ip}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }

    next();
  };
}

import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  MAX_IMAGE_BYTES,
  hasCachedImage,
  hashImageUrl,
  readCachedImage,
  storeCachedImage,
  touchCachedImage,
} from "../services/imageCache.js";
import { isArtworkHostAllowed } from "../services/proxy.js";
import { fetchAllowlisted } from "../services/safeFetch.js";
import { logger } from "../logger.js";

/**
 * `GET /api/artwork?url=…` — the server-side artwork cache.
 *
 * The client points every `<img>` here instead of at YouTube directly, so a
 * thumbnail is fetched from the origin once per instance rather than once per
 * browser session, and survives a device switch because it no longer lives in
 * an individual browser's image cache.
 *
 * Public by design (artwork is public content, and an `<img>` cannot carry a
 * session in any useful way), which is why the host policy in
 * `isArtworkHostAllowed` is deliberately narrower than the general proxy
 * allowlist: this is an unauthenticated GET.
 */

/**
 * 30 days. Album art essentially never changes, and `immutable` keeps the
 * browser from revalidating a grid of 50 thumbnails on every visit.
 */
const CACHE_CONTROL = "public, max-age=2592000, immutable";

const MAX_URL_LENGTH = 8192;
const UPSTREAM_TIMEOUT_MS = 15_000;
/** A picture over this is still served, just never retained. */
const SERVE_ONLY_BYTES = MAX_IMAGE_BYTES;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
const ACCEPT_HEADER = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

type UpstreamResult =
  | { ok: true; image: { contentType: string; data: Uint8Array; bytes: number } }
  | { ok: false; status: number; error: string };

/**
 * Cold-cache stampedes are the expensive case: opening a 50-track grid fires
 * 50 `<img>` loads at once and several of them can be the same picture. Coalescing
 * concurrent misses on one key means one origin fetch instead of N.
 */
const inFlight = new Map<string, Promise<UpstreamResult>>();

/** Negative cache so a dead host is not retried once per failing thumbnail. */
const recentFailures = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 5_000;

/**
 * The ETag is always the hash of the **raw query string**, i.e. the cache key.
 * Hashing the parsed/normalized URL instead would mint a different validator
 * on the miss (which sees the fetched URL) than on the hit (which reads by
 * key), and `If-None-Match` would then never match.
 */
function sendImage(
  res: Response,
  image: { contentType: string; data: Uint8Array; bytes: number },
  etag: string,
): void {
  res.setHeader("content-type", image.contentType);
  res.setHeader("content-length", String(image.bytes));
  res.setHeader("cache-control", CACHE_CONTROL);
  res.setHeader("etag", `"${etag}"`);
  res.status(200).end(Buffer.from(image.data));
}

async function fetchAndStore(target: URL): Promise<UpstreamResult> {
  let response: globalThis.Response;
  try {
    response = await fetchAllowlisted(
      target,
      {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: ACCEPT_HEADER },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
      { isAllowed: isArtworkHostAllowed },
    );
  } catch (error) {
    logger.warn("artwork.upstream failed", {
      host: target.hostname,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 502, error: "Artwork source is unreachable." };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: `Artwork source returned HTTP ${response.status}.` };
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    // A non-image answer means the URL was not actually artwork; serving it
    // from an image endpoint would be a content-type confusion vector.
    return { ok: false, status: 415, error: "That URL does not return an image." };
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, status: 502, error: "Artwork source closed the connection." };
  }

  const bytes = data.byteLength;
  if (bytes === 0) return { ok: false, status: 502, error: "Artwork source returned an empty image." };

  // Oversized pictures are still returned here; the route decides whether to
  // retain them. Refusing them outright would break artwork the origin
  // legitimately serves.
  return { ok: true, image: { contentType, data, bytes } };
}

export function createArtworkRoutes(db: Db): Router {
  const router = express.Router();
  // A grid of thumbnails is a legitimate burst; this bounds a runaway client
  // without throttling normal browsing.
  const limiter = rateLimit({ name: "artwork", windowMs: 60_000, max: 6000 });

  router.get("/", limiter, async (req: Request, res: Response) => {
    const raw = req.query.url;
    if (typeof raw !== "string" || !raw || raw.length > MAX_URL_LENGTH) {
      res.status(400).json({ error: "A url query parameter is required." });
      return;
    }

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.status(400).json({ error: "url must be an absolute URL." });
      return;
    }
    if (!isArtworkHostAllowed(target)) {
      res.status(403).json({ error: "That host is not on the artwork allowlist." });
      return;
    }

    const hash = hashImageUrl(raw);

    // Serve the revalidation path without touching the blob: the browser only
    // sends If-None-Match after max-age expires, but when it does the reply
    // should cost a single index probe rather than a table read.
    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && ifNoneMatch === `"${hash}"`) {
      if (hasCachedImage(db, raw)) {
        touchCachedImage(db, raw);
        res.setHeader("cache-control", CACHE_CONTROL);
        res.setHeader("etag", `"${hash}"`);
        res.status(304).end();
        return;
      }
    }

    const cached = readCachedImage(db, raw);
    if (cached) {
      sendImage(
        res,
        { contentType: cached.contentType, data: cached.data, bytes: cached.bytes },
        hash,
      );
      return;
    }

    const failedUntil = recentFailures.get(hash);
    if (failedUntil !== undefined && Date.now() < failedUntil) {
      res.status(502).json({ error: "Artwork source is unreachable." });
      return;
    }

    let pending = inFlight.get(hash);
    if (!pending) {
      pending = fetchAndStore(target);
      inFlight.set(hash, pending);
      void pending.then(
        () => inFlight.delete(hash),
        () => inFlight.delete(hash),
      );
    }
    const outcome = await pending;

    if (!outcome.ok) {
      recentFailures.set(hash, Date.now() + FAILURE_COOLDOWN_MS);
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    recentFailures.delete(hash);

    if (outcome.image.bytes <= SERVE_ONLY_BYTES) {
      storeCachedImage(db, raw, outcome.image.contentType, outcome.image.data);
    }
    sendImage(res, outcome.image, hash);
  });

  return router;
}

import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { requireAuth, requireSession } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCodeResponse,
} from "../services/youtubeOAuth.js";
import {
  hasValidYouTubeLink,
  saveYouTubeTokens,
  unlinkYouTubeAccount,
} from "../services/youtubeAccount.js";
import { getYouTubeLibrary } from "../services/youtubeLibrary.js";
import {
  clearYouTubeCookies,
  getYouTubeCookieStatus,
  normalizeCookieHeader,
  saveYouTubeCookies,
  verifyYouTubeSession,
} from "../services/youtubeCookies.js";
import { logger } from "../logger.js";

/**
 * YouTube Music account linking via Google's device-code OAuth flow — the web
 * equivalent of the desktop app's native sign-in webview. The user opens
 * youtube.com/activate in any browser, enters the displayed code, and this
 * server receives OAuth tokens (stored encrypted; never sent to the client).
 */

type LinkState = "idle" | "pending" | "linked" | "error";

interface PendingLink {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalSec: number;
  state: "pending" | "error";
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  completedAt?: number;
}

export interface YoutubeStatusResponse {
  state: LinkState;
  linked: boolean;
  /** True when a YouTube session-cookie header is stored for playback. */
  cookiesLinked: boolean;
  cookiesUpdatedAt: number | null;
  verificationUrl?: string;
  userCode?: string;
  expiresInSec?: number;
  error?: string;
}

const pendingLinks = new Map<string, PendingLink>();
const COMPLETED_KEEPM_MS = 30_000;

function clearPending(userId: string): void {
  const pending = pendingLinks.get(userId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingLinks.delete(userId);
}

function schedulePoll(
  db: Db,
  config: ServerConfig,
  userId: string,
  pending: PendingLink,
): void {
  const remainingMs = pending.expiresAt - Date.now();
  if (remainingMs <= 0) {
    pending.state = "error";
    pending.error = "The device code expired before sign-in completed.";
    pending.timer = setTimeout(() => clearPending(userId), COMPLETED_KEEPM_MS);
    return;
  }

  pending.timer = setTimeout(
    async () => {
      const current = pendingLinks.get(userId);
      if (current !== pending) return;
      try {
        const result = await pollDeviceToken(pending.deviceCode);
        if (result.status === "pending") {
          schedulePoll(db, config, userId, pending);
          return;
        }
        if (result.status === "success") {
          saveYouTubeTokens(db, config, userId, result.tokens);
          pending.state = "pending"; // link now exists in DB
          pending.completedAt = Date.now();
          logger.info("youtube.link completed", { userId });
          pending.timer = setTimeout(() => clearPending(userId), COMPLETED_KEEPM_MS);
          return;
        }
        pending.state = "error";
        pending.error =
          result.status === "denied"
            ? "Sign-in was cancelled."
            : result.status === "expired"
              ? "The device code expired. Please try again."
              : "YouTube sign-in failed. Please try again.";
        pending.timer = setTimeout(() => clearPending(userId), COMPLETED_KEEPM_MS);
      } catch (error) {
        logger.error("youtube.link poll crashed", { userId, error });
        pending.state = "error";
        pending.error = "YouTube sign-in failed. Please try again.";
        pending.timer = setTimeout(() => clearPending(userId), COMPLETED_KEEPM_MS);
      }
    },
    pending.intervalSec * 1000,
  );
}

function buildStatus(db: Db, userId: string): YoutubeStatusResponse {
  const linked = hasValidYouTubeLink(db, userId);
  const cookies = getYouTubeCookieStatus(db, userId);
  const base = { cookiesLinked: cookies.linked, cookiesUpdatedAt: cookies.updatedAt } as const;
  const pending = pendingLinks.get(userId);

  if (pending?.completedAt) {
    return { ...base, state: "linked", linked };
  }
  if (pending && pending.state === "error") {
    return {
      ...base,
      state: "error",
      linked,
      error: pending.error,
    };
  }
  if (pending && pending.state === "pending" && pending.expiresAt > Date.now()) {
    return {
      ...base,
      state: "pending",
      linked,
      verificationUrl: pending.verificationUrl,
      userCode: pending.userCode,
      expiresInSec: Math.ceil((pending.expiresAt - Date.now()) / 1000),
    };
  }
  if (pending) clearPending(userId);
  return { ...base, state: linked ? "linked" : "idle", linked };
}

export function createYoutubeAuthRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const startLimit = rateLimit({ name: "yt-link-start", windowMs: 60_000, max: 10 });

  router.get("/status", requireAuth, (req: Request, res: Response) => {
    res.json(buildStatus(db, req.sessionUserId!));
  });

  /**
   * The linked account's YouTube Music library, normalised server-side.
   *
   * This exists because an OAuth token only works against InnerTube's TVHTML5
   * client — WEB_REMIX (what a browser sends) rejects OAuth outright — so the
   * browser cannot read its own library. The server holds the refresh token
   * and does the TVHTML5 round trip here, returning plain JSON.
   *
   * 409 when no account is linked; 502 when YouTube is unreachable.
   */
  router.get("/library", requireAuth, async (req: Request, res: Response) => {
    const userId = req.sessionUserId!;
    if (!hasValidYouTubeLink(db, userId)) {
      res.status(409).json({ error: "No YouTube Music account is linked yet." });
      return;
    }
    try {
      const library = await getYouTubeLibrary(db, config, userId);
      if (!library) {
        res.status(502).json({ error: "YouTube Music did not return a library." });
        return;
      }
      res.json(library);
    } catch (error) {
      logger.error("youtube.library route failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "Unable to load the YouTube Music library." });
    }
  });

  router.post("/link", requireAuth, startLimit, async (req: Request, res: Response) => {
    const userId = req.sessionUserId!;
    const existing = buildStatus(db, userId);
    const reauthorize = req.body?.reauthorize === true;
    if (
      existing.state === "pending"
      || (existing.state === "linked" && !reauthorize)
    ) {
      res.json(existing);
      return;
    }

    try {
      const codes: DeviceCodeResponse = await requestDeviceCode();
      clearPending(userId);
      const pending: PendingLink = {
        deviceCode: codes.device_code,
        userCode: codes.user_code,
        verificationUrl: codes.verification_url,
        expiresAt: Date.now() + codes.expires_in * 1000,
        intervalSec: codes.interval,
        state: "pending",
      };
      pendingLinks.set(userId, pending);
      schedulePoll(db, config, userId, pending);
      res.json(buildStatus(db, userId));
    } catch (error) {
      logger.error("youtube.link start failed", { userId, error });
      res.status(502).json({
        error: "Unable to start YouTube sign-in. Please try again later.",
      });
    }
  });

  router.post("/cancel", requireAuth, (req: Request, res: Response) => {
    clearPending(req.sessionUserId!);
    res.json(buildStatus(db, req.sessionUserId!));
  });

  router.post("/unlink", requireAuth, async (req: Request, res: Response) => {
    const userId = req.sessionUserId!;
    clearPending(userId);
    await unlinkYouTubeAccount(db, config, userId);
    clearYouTubeCookies(db, userId);
    res.json({
      state: "idle" satisfies LinkState,
      linked: false,
      cookiesLinked: false,
      cookiesUpdatedAt: null,
    });
  });

  /**
   * Stores the user's YouTube session cookie header for authenticated
   * playback. This is the web-app equivalent of JAMC's embedded YouTube
   * login: the desktop app can read the webview's cookies, a browser cannot,
   * so the header is imported once and kept encrypted on the server.
   *
   * Session-only on purpose: an API key must not be able to replace the
   * account's YouTube credentials.
   */
  router.post("/cookies", requireSession, startLimit, async (req: Request, res: Response) => {
    const cookie = typeof req.body?.cookie === "string" ? req.body.cookie : "";
    const normalized = normalizeCookieHeader(cookie);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error });
      return;
    }

    // A header copied from `document.cookie` is missing YouTube's httpOnly
    // cookies (HSID, SSID), so SAPISIDHASH signs nothing and YouTube treats
    // the session as signed-out — playback fails with the same bot wall. Prove
    // the session before storing it, and say exactly what is wrong if not.
    const verification = await verifyYouTubeSession(normalized.cookie);
    if (!verification.authenticated) {
      res.status(400).json({
        error:
          "That cookie header is not a signed-in YouTube session. Copy the full Cookie request header from DevTools (Network → any /youtubei/ request), not document.cookie — the httpOnly cookies (HSID, SSID) are required.",
      });
      return;
    }

    const result = saveYouTubeCookies(db, config, req.sessionUserId!, normalized.cookie);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    logger.info("youtube.cookies saved", {
      userId: req.sessionUserId,
      account: verification.accountName ?? null,
    });
    res.json({ ...result.status, accountName: verification.accountName });
  });

  router.delete("/cookies", requireSession, (req: Request, res: Response) => {
    clearYouTubeCookies(db, req.sessionUserId!);
    logger.info("youtube.cookies cleared", { userId: req.sessionUserId });
    res.json({ linked: false, updatedAt: null });
  });

  return router;
}

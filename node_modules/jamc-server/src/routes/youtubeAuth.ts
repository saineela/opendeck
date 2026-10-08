import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { requireAuth } from "../middleware/session.js";
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
  const pending = pendingLinks.get(userId);

  if (pending?.completedAt) {
    return { state: "linked", linked };
  }
  if (pending && pending.state === "error") {
    return {
      state: linked ? "linked" : "error",
      linked,
      error: pending.error,
    };
  }
  if (pending && pending.state === "pending" && pending.expiresAt > Date.now()) {
    if (linked) return { state: "linked", linked };
    return {
      state: "pending",
      linked: false,
      verificationUrl: pending.verificationUrl,
      userCode: pending.userCode,
      expiresInSec: Math.ceil((pending.expiresAt - Date.now()) / 1000),
    };
  }
  if (pending) clearPending(userId);
  return { state: linked ? "linked" : "idle", linked };
}

export function createYoutubeAuthRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const startLimit = rateLimit({ name: "yt-link-start", windowMs: 60_000, max: 10 });

  router.get("/status", requireAuth, (req: Request, res: Response) => {
    res.json(buildStatus(db, req.sessionUserId!));
  });

  router.post("/link", requireAuth, startLimit, async (req: Request, res: Response) => {
    const userId = req.sessionUserId!;
    const existing = buildStatus(db, userId);
    if (existing.state === "linked" || existing.state === "pending") {
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
    res.json({ state: "idle" satisfies LinkState, linked: false });
  });

  return router;
}

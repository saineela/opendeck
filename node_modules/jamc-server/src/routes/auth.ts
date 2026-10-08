import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getDiscovery,
  verifyIdToken,
} from "../services/googleOAuth.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionId,
  requireAuth,
  setSessionCookie,
} from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { hasValidYouTubeLink } from "../services/youtubeAccount.js";
import { logger } from "../logger.js";

const OAUTH_COOKIE = "jamac_oauth";

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
}

function signValue(config: ServerConfig, value: string): string {
  return `${value}.${crypto.createHmac("sha256", config.appSecret).update(value).digest("base64url")}`;
}

function verifySignedValue(config: ServerConfig, signed: string): string | null {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;
  const value = signed.slice(0, separator);
  const expected = signValue(config, value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function sanitizeReturnTo(returnTo: unknown): string {
  if (typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return "/";
}

function readCookie(req: Request, name: string): string | null {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!raw) return null;
  return decodeURIComponent(raw.slice(name.length + 1));
}

const CALLBACK_SCRIPT = "/auth-callback.js";
// The HTML is served from /api/auth/google/callback, so the script src must
// include the mount prefix to actually resolve.
const CALLBACK_SCRIPT_SRC = "/api/auth/auth-callback.js";

const CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>Completing sign-in…</title>
  <script src="${CALLBACK_SCRIPT_SRC}" defer></script>
</head>
<body>
  <p>Completing sign-in… you can close this window.</p>
  <p id="auth-error" hidden></p>
</body>
</html>`;

export function createAuthRoutes(db: Db, config: ServerConfig): Router {
  const router = express.Router();
  const googleStartLimit = rateLimit({ name: "google-start", windowMs: 60_000, max: 20 });

  function sessionPayload(req: Request) {
    const user = req.authUser ?? null;
    return {
      authenticated: Boolean(user),
      user: user
        ? { name: user.name, email: user.email, picture: user.picture }
        : null,
      youtubeLinked: user ? hasValidYouTubeLink(db, user.id) : false,
    };
  }

  router.get("/session", (req: Request, res: Response) => {
    res.json(sessionPayload(req));
  });

  router.get("/google/start", googleStartLimit, async (req: Request, res: Response) => {
    if (!config.google.configured) {
      res.status(503).json({
        error:
          "Google Sign-In is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example).",
      });
      return;
    }
    try {
      const discovery = await getDiscovery(config);
      const stateValue = crypto.randomBytes(24).toString("base64url");
      const verifier = crypto.randomBytes(48).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const oauthState: OAuthState = {
        state: stateValue,
        verifier,
        returnTo: sanitizeReturnTo(req.query.returnTo),
      };
      res.cookie(OAUTH_COOKIE, signValue(config, JSON.stringify(oauthState)), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https://"),
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
      const authorizeUrl = buildAuthorizeUrl(config, discovery, {
        state: stateValue,
        codeChallenge: challenge,
        redirectUri: `${config.appUrl}/api/auth/google/callback`,
      });
      res.redirect(authorizeUrl);
    } catch (error) {
      logger.error("auth.google.start failed", { error });
      res.status(502).json({ error: "Unable to start Google Sign-In." });
    }
  });

  router.get("/google/callback", async (req: Request, res: Response) => {
    const failure = (message: string) => {
      res.status(400).type("html").send(
        CALLBACK_HTML.replace(
          "<p id=\"auth-error\" hidden></p>",
          `<p id="auth-error">${message.replace(/[<>&]/g, "")}</p>`,
        ),
      );
    };

    const oauthCookie = readCookie(req, OAUTH_COOKIE);
    res.clearCookie(OAUTH_COOKIE, { path: "/" });
    if (!oauthCookie) {
      failure("Sign-in session expired. Please try again.");
      return;
    }
    const stored = verifySignedValue(config, oauthCookie);
    if (!stored) {
      failure("Sign-in session could not be verified.");
      return;
    }
    let oauthState: OAuthState;
    try {
      oauthState = JSON.parse(stored) as OAuthState;
    } catch {
      failure("Sign-in session is malformed.");
      return;
    }

    if (req.query.error) {
      failure("Google sign-in was cancelled or refused.");
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state || state !== oauthState.state) {
      failure("Google sign-in state mismatch.");
      return;
    }

    if (!config.google.configured) {
      failure("Google Sign-In is not configured on this server.");
      return;
    }

    try {
      const discovery = await getDiscovery(config);
      const tokens = await exchangeCode(config, discovery, {
        code,
        codeVerifier: oauthState.verifier,
        redirectUri: `${config.appUrl}/api/auth/google/callback`,
      });
      if (!tokens.id_token) {
        failure("Google did not return an identity token.");
        return;
      }
      const profile = await verifyIdToken(config, discovery, tokens.id_token);
      const now = Date.now();
      db.prepare(
        `INSERT INTO users (id, google_sub, name, email, picture, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(google_sub) DO UPDATE SET
           name = excluded.name,
           email = COALESCE(excluded.email, users.email),
           picture = COALESCE(excluded.picture, users.picture),
           last_login_at = excluded.last_login_at`,
      ).run(
        crypto.randomUUID(),
        profile.sub,
        profile.name,
        profile.email ?? null,
        profile.picture ?? null,
        now,
        now,
      );
      const user = db
        .prepare("SELECT id FROM users WHERE google_sub = ?")
        .get(profile.sub) as { id: string };
      const sessionId = createSession(db, user.id);
      setSessionCookie(res, config, sessionId);
      res.status(200).type("html").send(CALLBACK_HTML);
      logger.info("auth.google.callback success", { userId: user.id });
    } catch (error) {
      logger.error("auth.google.callback failed", { error });
      failure("Google sign-in failed. Please try again.");
    }
  });

  router.get(CALLBACK_SCRIPT, (_req: Request, res: Response) => {
    res.type("application/javascript").send(
      `(function(){
  var errEl = document.getElementById('auth-error');
  var payload = { jamcAuth: true, ok: !errEl };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
      return;
    }
  } catch (e) { /* fall through to redirect */ }
  if (!errEl) {
    setTimeout(function(){ window.location.replace('/'); }, 800);
  }
})();`,
    );
  });

  router.post("/logout", (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    if (sessionId) destroySession(db, sessionId);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get("/whoami", requireAuth, (req: Request, res: Response) => {
    res.json(sessionPayload(req));
  });

  return router;
}

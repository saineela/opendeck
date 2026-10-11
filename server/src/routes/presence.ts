import express, { type Request, type Response, type Router } from "express";
import type { Db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { clearPresence, getPresenceState, updatePresence } from "../services/discordRpc.js";
import { logger } from "../logger.js";

/**
 * Discord Rich Presence reporting.
 *
 * The browser cannot reach Discord's IPC socket, so it tells *us* what is
 * playing and we forward it to the local Discord client. Two callers report:
 * the web player, and `/api/media/stream` (so a track played through the HTTP
 * API appears on Discord too, attributed to the API key's owner).
 *
 * Per-account settings live in `app_settings` under `discordPresence`:
 * `{ enabled, customMessage, showPlatform }`. The custom message is the
 * user's own status line, rendered above the track.
 *
 * "Secret Show": a per-account exception list (`secretShow`). Songs on it
 * play normally but never reach Discord — the profile shows nothing playing.
 * The check is enforced here, on the server, so an API play of an excepted
 * song is suppressed too, not just the browser's reports.
 */

const SETTING_KEY = "discordPresence";
const SECRET_SHOW_KEY = "secretShow";

export interface DiscordPresenceSettings {
  enabled: boolean;
  /** User-authored status line shown on the profile, e.g. "Coding OpenDeck". */
  customMessage: string;
  /** Append "via OpenDeck" so the platform is visible to friends. */
  showPlatform: boolean;
}

export const DEFAULT_PRESENCE_SETTINGS: DiscordPresenceSettings = {
  enabled: false,
  customMessage: "",
  showPlatform: true,
};

const MAX_MESSAGE_LENGTH = 128;
/** Bound the exception list so it cannot grow into an unbounded blob. */
const MAX_SECRET_TRACKS = 500;

export function readPresenceSettings(db: Db, userId: string): DiscordPresenceSettings {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE user_id = ? AND key = ?")
    .get(userId, SETTING_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_PRESENCE_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<DiscordPresenceSettings>;
    return {
      enabled: parsed.enabled === true,
      customMessage:
        typeof parsed.customMessage === "string"
          ? parsed.customMessage.slice(0, MAX_MESSAGE_LENGTH)
          : "",
      showPlatform: parsed.showPlatform !== false,
    };
  } catch {
    // A corrupt row must not brick presence for the account.
    return { ...DEFAULT_PRESENCE_SETTINGS };
  }
}

function writePresenceSettings(db: Db, userId: string, settings: DiscordPresenceSettings): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, SETTING_KEY, JSON.stringify(settings), now);
}

/** One song the user chose to listen to without broadcasting it. */
export interface SecretTrack {
  videoId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  addedAt: number;
}

/**
 * Reads the account's Secret Show list. A corrupt row degrades to empty —
 * losing privacy exceptions would be worse than an unreadable list.
 */
export function readSecretTracks(db: Db, userId: string): SecretTrack[] {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE user_id = ? AND key = ?")
    .get(userId, SECRET_SHOW_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as { tracks?: unknown };
    if (!Array.isArray(parsed.tracks)) return [];
    return parsed.tracks
      .filter((track): track is SecretTrack => {
        const candidate = track as Partial<SecretTrack>;
        return typeof candidate?.videoId === "string" && candidate.videoId.length > 0;
      })
      .slice(0, MAX_SECRET_TRACKS)
      .map((track) => ({
        videoId: track.videoId.slice(0, 32),
        title: typeof track.title === "string" ? track.title.slice(0, 200) : track.videoId,
        artist: typeof track.artist === "string" ? track.artist.slice(0, 200) : "",
        artworkUrl:
          typeof track.artworkUrl === "string" && track.artworkUrl.startsWith("https:")
            ? track.artworkUrl.slice(0, 2048)
            : undefined,
        addedAt: typeof track.addedAt === "number" ? track.addedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

function writeSecretTracks(db: Db, userId: string, tracks: SecretTrack[]): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, SECRET_SHOW_KEY, JSON.stringify({ tracks }), now);
}

/** True when this exact video must stay off the profile. */
export function isSecretTrack(db: Db, userId: string, videoId: string | null | undefined): boolean {
  if (!videoId) return false;
  return readSecretTracks(db, userId).some((track) => track.videoId === videoId);
}

/** What the browser sends when the player starts or changes track. */
interface NowPlayingReport {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  artworkUrl?: unknown;
  songUrl?: unknown;
  videoId?: unknown;
  currentTime?: unknown;
  duration?: unknown;
  isPlaying?: unknown;
}

function parseReport(body: NowPlayingReport | undefined) {
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const url = (value: unknown): string | undefined => {
    const candidate = text(value, 2048);
    if (!candidate) return undefined;
    try {
      return new URL(candidate).protocol === "https:" ? candidate : undefined;
    } catch {
      return undefined;
    }
  };
  const seconds = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;

  return {
    title: text(body?.title, 128),
    artist: text(body?.artist, 128),
    album: text(body?.album, 128),
    artworkUrl: url(body?.artworkUrl),
    songUrl: url(body?.songUrl),
    videoId: text(body?.videoId, 32),
    currentTime: seconds(body?.currentTime),
    duration: seconds(body?.duration),
    isPlaying: body?.isPlaying !== false,
  };
}

export function createPresenceRoutes(db: Db): Router {
  const router = express.Router();
  const limiter = rateLimit({ name: "presence", windowMs: 60_000, max: 240 });

  /** Capability probe — the UI shows "unavailable" instead of a dead switch. */
  router.get("/status", requireAuth, limiter, (_req: Request, res: Response) => {
    res.json(getPresenceState());
  });

  /** Current account's settings. */
  router.get("/settings", requireAuth, limiter, (req: Request, res: Response) => {
    res.json({
      settings: readPresenceSettings(db, req.sessionUserId!),
      maxMessageLength: MAX_MESSAGE_LENGTH,
    });
  });

  router.put("/settings", requireAuth, limiter, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = readPresenceSettings(db, req.sessionUserId!);

    const settings: DiscordPresenceSettings = {
      enabled: body.enabled === undefined ? current.enabled : body.enabled === true,
      customMessage:
        typeof body.customMessage === "string"
          ? body.customMessage.trim().slice(0, MAX_MESSAGE_LENGTH)
          : current.customMessage,
      showPlatform:
        body.showPlatform === undefined ? current.showPlatform : body.showPlatform === true,
    };

    writePresenceSettings(db, req.sessionUserId!, settings);
    if (!settings.enabled) {
      // Turning it off must clear what is already on the profile.
      void clearPresence();
    }
    logger.info("presence.settings", {
      userId: req.sessionUserId,
      enabled: settings.enabled,
      hasCustomMessage: Boolean(settings.customMessage),
    });
    res.json({ settings });
  });

  /** Report the current track. Silently a no-op when the user has it off. */
  router.post("/now-playing", requireAuth, limiter, (req: Request, res: Response) => {
    const settings = readPresenceSettings(db, req.sessionUserId!);
    if (!settings.enabled) {
      res.json({ ok: true, accepted: false, reason: "disabled" });
      return;
    }
    const parsed = parseReport(req.body as NowPlayingReport | undefined);
    if (!parsed.title) {
      res.json({ ok: true, accepted: false, reason: "no-title" });
      return;
    }

    // Secret Show: the song plays, the profile says nothing. Clear anything
    // already showing rather than leaving the previous track up.
    if (isSecretTrack(db, req.sessionUserId!, parsed.videoId)) {
      void clearPresence();
      res.json({ ok: true, accepted: false, reason: "secret-show" });
      return;
    }

    void updatePresence({
      title: parsed.title,
      artist: parsed.artist ?? "",
      album: parsed.album,
      artworkUrl: parsed.artworkUrl,
      songUrl: parsed.songUrl,
      currentTime: parsed.currentTime,
      duration: parsed.duration,
      isPlaying: parsed.isPlaying,
    }).catch((error) => logger.debug("presence.update failed", { error }));

    res.json({ ok: true, accepted: true, state: getPresenceState() });
  });

  /** Explicit clear (stop, sign-out, tab close). */
  router.post("/clear", requireAuth, limiter, (_req: Request, res: Response) => {
    void clearPresence();
    res.json({ ok: true });
  });

  /** The account's Secret Show list. */
  router.get("/secret-show", requireAuth, limiter, (req: Request, res: Response) => {
    const tracks = readSecretTracks(db, req.sessionUserId!);
    res.json({ tracks, max: MAX_SECRET_TRACKS, remaining: MAX_SECRET_TRACKS - tracks.length });
  });

  /** Add a song to Secret Show. Idempotent per videoId. */
  router.post("/secret-show", requireAuth, limiter, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const videoId = typeof body.videoId === "string" ? body.videoId.trim().slice(0, 32) : "";
    if (!videoId) {
      res.status(400).json({ error: "A videoId is required." });
      return;
    }
    const tracks = readSecretTracks(db, req.sessionUserId!);
    if (tracks.some((track) => track.videoId === videoId)) {
      res.json({ tracks, added: false });
      return;
    }
    if (tracks.length >= MAX_SECRET_TRACKS) {
      res.status(409).json({ error: `Secret Show holds at most ${MAX_SECRET_TRACKS} songs.` });
      return;
    }
    const entry: SecretTrack = {
      videoId,
      title:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 200)
          : videoId,
      artist: typeof body.artist === "string" ? body.artist.trim().slice(0, 200) : "",
      artworkUrl:
        typeof body.artworkUrl === "string" && body.artworkUrl.startsWith("https:")
          ? body.artworkUrl.slice(0, 2048)
          : undefined,
      addedAt: Date.now(),
    };
    tracks.push(entry);
    writeSecretTracks(db, req.sessionUserId!, tracks);
    logger.info("presence.secret-show.add", { userId: req.sessionUserId, videoId });
    res.json({ tracks, added: true });
  });

  /** Remove a song from Secret Show. */
  router.delete("/secret-show/:videoId", requireAuth, limiter, (req: Request, res: Response) => {
    const raw = req.params.videoId;
    const videoId = typeof raw === "string" ? raw.slice(0, 32) : "";
    const tracks = readSecretTracks(db, req.sessionUserId!);
    const next = tracks.filter((track) => track.videoId !== videoId);
    writeSecretTracks(db, req.sessionUserId!, next);
    if (next.length !== tracks.length) {
      logger.info("presence.secret-show.remove", { userId: req.sessionUserId, videoId });
    }
    res.json({ tracks: next });
  });

  return router;
}

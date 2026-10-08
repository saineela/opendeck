import type { Track } from "../datasource/types";
import { getAuthStatusSnapshot } from "../auth/authClient";
import { logInternalDebug, logInternalWarn } from "../internal/logging";

/**
 * Last.fm client logic (thresholds, now-playing, scrobble timing) is kept from
 * the desktop app; the Rust `lastfm_*` transport commands are replaced by the
 * web backend's `/api/lastfm/*` endpoints (API key/secret stay server-side).
 */

async function postLastFm<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/lastfm/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Last.fm request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export interface LastFmAuthStart {
  token: string;
  authUrl: string;
}

export interface LastFmSessionStatus {
  username: string;
}

interface LastFmTrackPayload {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
}

interface LastFmScrobblePayload extends LastFmTrackPayload {
  timestamp: number;
}

type PlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

interface PlaybackUpdate {
  track: Track | null;
  status: PlaybackStatus;
  currentTime: number;
  duration: number;
  enabled: boolean;
}

interface TrackedTrackState {
  key: string;
  payload: LastFmTrackPayload;
  startTimestamp: number;
  listenedSec: number;
  lastObservedAtMs: number | null;
  nowPlayingSent: boolean;
  scrobbled: boolean;
}

const MIN_SCROBBLE_DURATION_SEC = 31;
const MAX_THRESHOLD_SEC = 240;

function cleanText(value?: string): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function createPayload(track: Track, duration: number): LastFmTrackPayload | null {
  const artist = cleanText(track.artist || track.artists?.map((item) => item.name).join(", "));
  const title = cleanText(track.title);
  if (!artist || !title) return null;

  const safeDuration = Number.isFinite(duration) && duration > 0
    ? Math.round(duration)
    : track.durationSec
      ? Math.round(track.durationSec)
      : undefined;

  return {
    artist,
    track: title,
    album: cleanText(track.album) || undefined,
    duration: safeDuration,
  };
}

function trackKey(track: Track, payload: LastFmTrackPayload) {
  return [
    track.source,
    track.id,
    payload.artist.toLowerCase(),
    payload.track.toLowerCase(),
  ].join(":");
}

function scrobbleThreshold(duration?: number): number | null {
  if (!duration || duration < MIN_SCROBBLE_DURATION_SEC) return null;
  return Math.min(MAX_THRESHOLD_SEC, duration / 2);
}

export class LastFmService {
  private static tracked: TrackedTrackState | null = null;
  private static sessionChecked = false;
  private static hasSession = false;

  static async startAuth(): Promise<LastFmAuthStart> {
    const auth = await postLastFm<LastFmAuthStart>("start");
    openInNewTab(auth.authUrl);
    return auth;
  }

  static async completeAuth(token: string): Promise<LastFmSessionStatus> {
    const session = await postLastFm<LastFmSessionStatus>("complete", { token });
    this.sessionChecked = true;
    this.hasSession = true;
    return session;
  }

  static async getSession(): Promise<LastFmSessionStatus | null> {
    if (getAuthStatusSnapshot() !== "signed-in") {
      this.sessionChecked = true;
      this.hasSession = false;
      return null;
    }
    try {
      const response = await fetch("/api/lastfm/status", { headers: { accept: "application/json" } });
      if (!response.ok) {
        this.sessionChecked = true;
        this.hasSession = false;
        return null;
      }
      const payload = (await response.json()) as { session: { username: string } | null };
      const session = payload.session ? { username: payload.session.username } : null;
      this.sessionChecked = true;
      this.hasSession = Boolean(session);
      return session;
    } catch (error) {
      this.sessionChecked = true;
      this.hasSession = false;
      throw error;
    }
  }

  static async disconnect(): Promise<void> {
    await postLastFm("disconnect");
    this.sessionChecked = true;
    this.hasSession = false;
    this.tracked = null;
  }

  static updatePlayback(update: PlaybackUpdate): void {
    if (!update.enabled || !update.track || update.status === "idle" || update.status === "error") {
      this.tracked = null;
      return;
    }

    const payload = createPayload(update.track, update.duration);
    if (!payload) {
      this.tracked = null;
      return;
    }

    const key = trackKey(update.track, payload);
    const nowMs = Date.now();
    if (!this.tracked || this.tracked.key !== key) {
      this.tracked = {
        key,
        payload,
        startTimestamp: Math.max(0, Math.floor(nowMs / 1000 - Math.max(0, update.currentTime))),
        listenedSec: 0,
        lastObservedAtMs: update.status === "playing" ? nowMs : null,
        nowPlayingSent: false,
        scrobbled: false,
      };
    }

    if (update.status !== "playing") {
      this.tracked.lastObservedAtMs = null;
      return;
    }

    if (this.tracked.lastObservedAtMs !== null) {
      const deltaSec = Math.max(0, Math.min(5, (nowMs - this.tracked.lastObservedAtMs) / 1000));
      this.tracked.listenedSec += deltaSec;
    }
    this.tracked.lastObservedAtMs = nowMs;

    if (!this.tracked.nowPlayingSent) {
      this.tracked.nowPlayingSent = true;
      void this.updateNowPlaying(this.tracked.payload);
    }

    const threshold = scrobbleThreshold(this.tracked.payload.duration);
    if (!threshold || this.tracked.scrobbled || this.tracked.listenedSec < threshold) return;

    this.tracked.scrobbled = true;
    void this.scrobble({
      ...this.tracked.payload,
      timestamp: this.tracked.startTimestamp,
    });
  }

  private static async ensureSession(): Promise<boolean> {
    if (this.sessionChecked) return this.hasSession;
    try {
      await this.getSession();
    } catch (error) {
      logInternalWarn("LastFm.sessionCheck.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.sessionChecked = true;
      this.hasSession = false;
    }
    return this.hasSession;
  }

  private static async updateNowPlaying(payload: LastFmTrackPayload): Promise<void> {
    if (!await this.ensureSession()) return;
    try {
      await postLastFm("now-playing", payload);
      logInternalDebug("LastFm.nowPlaying.success", {
        artist: payload.artist,
        track: payload.track,
      });
    } catch (error) {
      logInternalWarn("LastFm.nowPlaying.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static async scrobble(payload: LastFmScrobblePayload): Promise<void> {
    if (!await this.ensureSession()) return;
    try {
      await postLastFm("scrobble", payload);
      logInternalDebug("LastFm.scrobble.success", {
        artist: payload.artist,
        track: payload.track,
      });
    } catch (error) {
      logInternalWarn("LastFm.scrobble.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

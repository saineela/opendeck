import { logInternalDebug, logInternalWarn } from "../internal/logging";

export interface DiscordPresenceData {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  songUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  /** YouTube video id — lets the server match Secret Show exceptions. */
  videoId?: string;
  duration: number; // in seconds
  currentTime: number; // in seconds
  isPlaying: boolean;
}

/**
 * Discord Rich Presence over HTTP.
 *
 * Browsers cannot open Discord's IPC socket, which is why the original
 * desktop app did this from Rust and the web port first shipped an inert
 * stub. OpenDeck owns a Node server though, so the browser reports what is
 * playing to `/api/presence/now-playing` and the server pushes it to the
 * Discord client running on *its* machine.
 *
 * That locality is the honest limitation: if the server is remote from your
 * Discord, nothing appears, and `/api/presence/status` reports
 * `connected: false` so the UI can say so rather than silently doing nothing.
 *
 * Everything here fails soft — presence is decoration and must never disturb
 * playback or spam the console.
 */

/** Server-side throttle is 5 s; report a little less often than that. */
const REPORT_INTERVAL_MS = 15_000;

let enabled = false;
let lastReportAt = 0;
let lastSignature: string | null = null;
/** Pending report timer, so a burst of position updates collapses to one. */
let scheduled: number | null = null;
/** Latest payload, sent when the debounce fires. */
let pending: DiscordPresenceData | null = null;
/** Set once the server says the account has presence off. */
let serverDisabled = false;

function signatureOf(data: DiscordPresenceData): string {
  return [
    data.title,
    data.artist,
    data.album,
    data.isPlaying ? "p" : "s",
    // Bucket the position so per-second clock ticks are not resent.
    Math.floor(data.currentTime / 15),
  ].join("|");
}

async function send(data: DiscordPresenceData): Promise<void> {
  try {
    const response = await fetch("/api/presence/now-playing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: data.title,
        artist: data.artist,
        album: data.album,
        artworkUrl: data.artworkUrl,
        songUrl: data.songUrl,
        videoId: data.videoId,
        currentTime: data.currentTime,
        duration: data.duration,
        isPlaying: data.isPlaying,
      }),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { accepted?: boolean; reason?: string };
    // "disabled" means the account turned presence off — stop reporting
    // instead of polling forever. A "secret-show" rejection is per-track:
    // this song stays quiet, the next one reports normally.
    if (payload.accepted === false && payload.reason === "disabled") {
      serverDisabled = true;
    }
    lastReportAt = Date.now();
  } catch {
    // Offline or mid-restart; the next track will try again.
  }
}

export class DiscordRpcService {
  /**
   * Adopt a resolved preference. Called from settings hydration so a signed-in
   * account does not report before we know whether it opted in.
   */
  static async setEnabled(next: boolean): Promise<void> {
    enabled = next;
    serverDisabled = false;
    logInternalDebug("Discord.setEnabled", { enabled: next });
    if (!next) {
      await DiscordRpcService.clearPresence(true);
    }
  }

  static async updatePresence(data: DiscordPresenceData): Promise<void> {
    if (!enabled || serverDisabled) return;

    const signature = signatureOf(data);
    if (signature === lastSignature) return;

    // Collapse rapid updates: a track's clock fires every second, and seeks
    // change currentTime repeatedly. Send immediately only when idle-ish long
    // enough; otherwise coalesce into one request.
    const due = Date.now() - lastReportAt >= REPORT_INTERVAL_MS;
    pending = data;
    lastSignature = signature;

    if (due) {
      if (scheduled !== null) {
        window.clearTimeout(scheduled);
        scheduled = null;
      }
      await send(data);
      return;
    }
    if (scheduled !== null) return;
    scheduled = window.setTimeout(() => {
      scheduled = null;
      if (pending && enabled && !serverDisabled) void send(pending);
    }, REPORT_INTERVAL_MS - (Date.now() - lastReportAt));
  }

  static async clearPresence(force = false): Promise<void> {
    pending = null;
    lastSignature = null;
    if (scheduled !== null) {
      window.clearTimeout(scheduled);
      scheduled = null;
    }
    if (!enabled && !force) return;
    try {
      await fetch("/api/presence/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch {
      logInternalWarn("Discord.clearPresence failed", {});
    }
  }
}

export default DiscordRpcService;

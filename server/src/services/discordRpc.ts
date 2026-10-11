import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ServerConfig } from "../config.js";
import { logger } from "../logger.js";

/**
 * Discord Rich Presence, driven from the server instead of the browser.
 *
 * Browsers cannot reach Discord's IPC socket, which is why the original
 * desktop app did this from Rust and the web port shipped an inert stub. But
 * OpenDeck owns a Node process — so the browser reports what is playing to us
 * and *we* talk to the local Discord client.
 *
 * The honest constraint: this only reaches a Discord running **on the same
 * machine as the OpenDeck server**. Self-hosting on a NAS means the NAS's
 * Discord socket, which is usually empty. That is a property of Discord's
 * local-IPC design, not of this implementation; the endpoint reports
 * `connected: false` rather than pretending, and the UI says so.
 *
 * No dependency: the protocol is a length-prefixed JSON frame over a unix
 * socket (or a named pipe on Windows). Handshake is an HTTP-looking request;
 * after that every message is `{opcode: u32le, length: u32le, json}`.
 */

/**
 * Discord opcodes. The handshake is sent as a plain HTTP-looking request, so
 * OP_HANDSHAKE is never written as a frame and is not declared here.
 */
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Discord's own socket names, tried in order. */
const SOCKET_CANDIDATES = 10;
/** Give up on a socket quickly — presence is cosmetic, never blocking. */
const CONNECT_TIMEOUT_MS = 1500;
/** Discord rate-limits SET_ACTIVITY; also saves us chatty reconnects. */
const MIN_UPDATE_INTERVAL_MS = 5_000;

export interface PresencePayload {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  songUrl?: string;
  artistUrl?: string;
  /** Seconds. Discord shows elapsed time from `start`. */
  duration?: number;
  /** Seconds elapsed in the track. */
  currentTime?: number;
  isPlaying: boolean;
}

export interface PresenceState {
  configured: boolean;
  /** A Discord client accepted our handshake on this machine. */
  connected: boolean;
  /** True once we have stopped retrying for a while (no Discord nearby). */
  unavailable: boolean;
  lastError: string | null;
}

/** Base directories Discord puts its socket in, per platform. */
function socketDirectories(): string[] {
  const dirs: string[] = [];
  if (process.platform === "win32") {
    // Named pipes are addressed by name, not a directory; handled separately.
    return dirs;
  }
  if (process.env.XDG_RUNTIME_DIR) dirs.push(process.env.XDG_RUNTIME_DIR);
  if (process.platform === "darwin") {
    dirs.push(os.tmpdir());
  } else {
    dirs.push("/tmp");
    const snap = "/run/user/" + String(process.getuid?.() ?? 0);
    dirs.push(snap);
  }
  return dirs;
}

function socketPath(index: number): string {
  const name = `discord-ipc-${index}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const dirs = socketDirectories();
  return path.join(dirs[0] ?? os.tmpdir(), name);
}

/** One framed message. Opcode and length are little-endian uint32. */
function encodeFrame(opcode: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

interface DiscordActivity {
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
  buttons?: Array<{ label: string; url: string }>;
  instance?: boolean;
}

/** Truncate to Discord's field limits rather than getting the update rejected. */
function clamp(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Discord accepts external https URLs for `large_image`, not bare http. */
function presenceImage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("https://") ? url : undefined;
}

/**
 * A single shared connection. Discord only needs one socket per process, and
 * one user's playback must not open a socket per request.
 */
class DiscordPresenceBridge {
  private socket: net.Socket | null = null;
  private clientId: string | null = null;
  private connected = false;
  private connecting: Promise<boolean> | null = null;
  private nonce = 0;
  private lastError: string | null = null;
  private lastUpdateAt = 0;
  /** Last payload we successfully pushed, used to skip redundant updates. */
  private lastSignature: string | null = null;
  /** After a failed connect, stop hammering Discord for a while. */
  private retryAfter = 0;

  configure(clientId: string | null): void {
    if (clientId === this.clientId) return;
    this.clientId = clientId;
    this.teardown();
  }

  get configured(): boolean {
    return Boolean(this.clientId);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get unavailable(): boolean {
    return !this.configured || Date.now() < this.retryAfter;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private teardown(): void {
    if (this.socket) {
      try {
        this.socket.write(encodeFrame(OP_CLOSE, { code: 1000, message: "bye" }));
      } catch {
        // Already gone; nothing to do.
      }
      this.socket.destroy();
    }
    this.socket = null;
    this.connected = false;
    this.lastSignature = null;
  }

  /** Connect and handshake. Resolves false (never throws) when unavailable. */
  private async connect(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      if (!this.clientId) return false;
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;

      for (let index = 0; index < SOCKET_CANDIDATES; index += 1) {
        const target = socketPath(index);
        const ok = await this.tryConnect(target, deadline);
        if (ok) return true;
      }

      this.lastError = "No Discord client is listening on this machine.";
      // Back off so a server with no Discord nearby does not retry per track.
      this.retryAfter = Date.now() + 60_000;
      return false;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private tryConnect(target: string, deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const socket = net.connect(target);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        if (!ok) socket.destroy();
        resolve(ok);
      };

      socket.setTimeout(Math.max(250, deadline - Date.now()), () => finish(false));
      socket.once("error", () => finish(false));

      socket.once("connect", () => {
        // The handshake is an HTTP-shaped request Discord answers with READY.
        socket.write(
          `GET /?v=1&client_id=${encodeURIComponent(this.clientId!)} HTTP/1.1\r\n`
            + `Host: ${target}\r\n`
            + "Origin: http://localhost\r\n\r\n",
        );
        // We do not strictly need to read READY before the first SET_ACTIVITY,
        // but reading keeps the socket flowing and lets us detect closure.
        socket.setTimeout(0);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.once("close", () => {
          this.connected = false;
          this.socket = null;
          this.lastSignature = null;
        });
        this.socket = socket;
        this.connected = true;
        this.lastError = null;
        this.retryAfter = 0;
        finish(true);
      });
    });
  }

  /** Drains frames; only PING needs an answer. */
  private onData(chunk: Buffer): void {
    let offset = 0;
    while (offset + 8 <= chunk.length) {
      const opcode = chunk.readUInt32LE(offset);
      const length = chunk.readUInt32LE(offset + 4);
      offset += 8 + length;
      if (opcode === OP_PING) {
        try {
          this.socket?.write(encodeFrame(OP_PONG, {}));
        } catch {
          // Cosmetic; a dead socket fails on the next update instead.
        }
      }
      if (opcode === OP_CLOSE) {
        this.connected = false;
      }
    }
  }

  private sendActivity(payload: PresencePayload): void {
    if (!this.socket || !this.connected) return;

    const startOffset = (payload.currentTime ?? 0) * 1000;
    const startedAt = Date.now() - startOffset;

    const activity: DiscordActivity = {
      details: clamp(payload.title, 128),
      state: clamp(
        [payload.artist, payload.album].filter(Boolean).join(" · ") || undefined,
        128,
      ),
      assets: {
        large_image: presenceImage(payload.artworkUrl),
        large_text: clamp(payload.album || payload.artist, 128),
        small_image: "opendeck",
        small_text: "OpenDeck",
      },
      buttons: payload.songUrl
        ? [{ label: "Play on OpenDeck", url: payload.songUrl }]
        : undefined,
      instance: false,
    };

    if (payload.isPlaying) {
      // Elapsed time; a paused track has no useful clock, so we omit it and
      // Discord simply stops advancing rather than counting the pause.
      activity.timestamps = { start: startedAt };
    }
    if (!activity.details && !activity.state) return;

    this.nonce += 1;
    try {
      this.socket.write(
        encodeFrame(OP_FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity },
          nonce: String(this.nonce),
        }),
      );
      this.lastSignature = this.signatureOf(payload);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.connected = false;
    }
  }

  private signatureOf(payload: PresencePayload): string {
    return [
      payload.title,
      payload.artist,
      payload.album ?? "",
      payload.isPlaying ? "p" : "s",
      // Bucket the position so a seek or a new second does not resend.
      Math.floor((payload.currentTime ?? 0) / 15),
    ].join("|");
  }

  /**
   * Push an update. Throttled and de-duplicated: Discord dislikes rapid
   * SET_ACTIVITY, and a track clock firing every second would otherwise spam
   * the socket for no visible change.
   */
  async update(payload: PresencePayload): Promise<void> {
    if (!this.configured) return;
    const signature = this.signatureOf(payload);
    if (signature === this.lastSignature) return;
    if (Date.now() - this.lastUpdateAt < MIN_UPDATE_INTERVAL_MS) return;

    if (!this.connected) {
      const ok = await this.connect();
      if (!ok) return;
    }
    this.lastUpdateAt = Date.now();
    this.sendActivity(payload);
  }

  /** Clear the activity, e.g. on stop or sign-out. */
  async clear(): Promise<void> {
    this.lastSignature = null;
    if (!this.socket || !this.connected) return;
    this.nonce += 1;
    try {
      this.socket.write(
        encodeFrame(OP_FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity: undefined },
          nonce: String(this.nonce),
        }),
      );
    } catch (error) {
      logger.debug("discord.clear failed", { error });
      this.connected = false;
    }
  }
}

const bridge = new DiscordPresenceBridge();

export function configureDiscord(config: ServerConfig): void {
  bridge.configure(config.discordClientId);
  if (config.discordClientId) {
    logger.info("discord.configured", { clientId: config.discordClientId });
  }
}

export function getPresenceState(): PresenceState {
  return {
    configured: bridge.configured,
    connected: bridge.isConnected,
    unavailable: bridge.unavailable,
    lastError: bridge.getLastError(),
  };
}

export async function updatePresence(payload: PresencePayload): Promise<void> {
  await bridge.update(payload);
}

export async function clearPresence(): Promise<void> {
  await bridge.clear();
}

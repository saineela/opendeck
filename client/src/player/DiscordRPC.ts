import { logInternalDebug } from "../internal/logging";

export interface DiscordPresenceData {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  songUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  duration: number; // in seconds
  currentTime: number; // in seconds
  isPlaying: boolean;
}

/**
 * Discord Rich Presence is a desktop-only capability: the original app talked
 * to the local Discord client over IPC from Rust, which browsers cannot do.
 * This service is intentionally inert on the web so the player can keep
 * calling it unconditionally. See README ("Not reproducible on the web").
 */
export class DiscordRpcService {

  static async init(): Promise<void> {
    logInternalDebug("Discord.init", { platform: "web", available: false });
  }

  static async setEnabled(enabled: boolean): Promise<void> {
    void enabled;
  }

  static async updatePresence(data: DiscordPresenceData): Promise<void> {
    void data;
  }

  static async clearPresence(force = false): Promise<void> {
    void force;
  }
}

export default DiscordRpcService;

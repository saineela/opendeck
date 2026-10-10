import { logInternalWarn } from "./logging";
import { DiscordRpcService } from "../player/DiscordRPC";

/**
 * Discord Rich Presence settings (`/api/presence/*`).
 *
 * The switch is per account and durable server-side, so it follows the user
 * across devices. `status` reports whether the *server* can actually reach a
 * local Discord client — that is the honest answer for a remote deployment.
 */

export interface PresenceSettings {
  enabled: boolean;
  /** User-authored status line shown above the track on the profile. */
  customMessage: string;
  /** Append the platform name so friends see where it is playing from. */
  showPlatform: boolean;
}

export interface PresenceStatus {
  configured: boolean;
  connected: boolean;
  unavailable: boolean;
  lastError: string | null;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  enabled: false,
  customMessage: "",
  showPlatform: true,
};

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/presence${pathname}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getPresenceStatus(): Promise<PresenceStatus | null> {
  try {
    return await requestJson<PresenceStatus>("/status");
  } catch (error) {
    logInternalWarn("presence.status failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getPresenceSettings(): Promise<PresenceSettings> {
  try {
    const payload = await requestJson<{ settings: PresenceSettings }>("/settings");
    return payload.settings ?? { ...DEFAULT_PRESENCE_SETTINGS };
  } catch {
    return { ...DEFAULT_PRESENCE_SETTINGS };
  }
}

export async function savePresenceSettings(
  settings: PresenceSettings,
): Promise<PresenceSettings> {
  const payload = await requestJson<{ settings: PresenceSettings }>("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  return payload.settings;
}

/** One song hidden from Discord by Secret Show. */
export interface SecretTrack {
  videoId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  addedAt: number;
}

export interface SecretShowList {
  tracks: SecretTrack[];
  max: number;
  remaining: number;
}

export async function getSecretTracks(): Promise<SecretShowList> {
  try {
    return await requestJson<SecretShowList>("/secret-show");
  } catch {
    return { tracks: [], max: 500, remaining: 500 };
  }
}

export async function addSecretTrack(track: Omit<SecretTrack, "addedAt">): Promise<SecretShowList> {
  return requestJson<SecretShowList>("/secret-show", {
    method: "POST",
    body: JSON.stringify(track),
  });
}

export async function removeSecretTrack(videoId: string): Promise<SecretShowList> {
  return requestJson<SecretShowList>(`/secret-show/${encodeURIComponent(videoId)}`, {
    method: "DELETE",
  });
}

/**
 * Shared cache of the Secret Show list, so the track context menu can label
 * songs without a fetch per menu-open. Loaded lazily, refreshed by add/remove.
 */
let secretTracks: SecretTrack[] = [];
let secretLoaded = false;
const secretListeners = new Set<() => void>();

function emitSecret() {
  for (const listener of secretListeners) listener();
}

export function subscribeSecretTracks(listener: () => void): () => void {
  secretListeners.add(listener);
  return () => secretListeners.delete(listener);
}

export function getSecretTracksSnapshot(): SecretTrack[] {
  return secretTracks;
}

export function isTrackSecret(videoId: string | undefined): boolean {
  if (!videoId) return false;
  return secretTracks.some((track) => track.videoId === videoId);
}

/** Fetch once per session; safe to call on every menu open. */
export async function ensureSecretTracksLoaded(): Promise<void> {
  if (secretLoaded) return;
  const list = await getSecretTracks();
  secretTracks = list.tracks;
  secretLoaded = true;
  emitSecret();
}

export async function addSecretTrackShared(
  track: Omit<SecretTrack, "addedAt">,
): Promise<SecretTrack[]> {
  const list = await addSecretTrack(track);
  secretTracks = list.tracks;
  secretLoaded = true;
  emitSecret();
  return secretTracks;
}

export async function removeSecretTrackShared(videoId: string): Promise<SecretTrack[]> {
  const list = await removeSecretTrack(videoId);
  secretTracks = list.tracks;
  secretLoaded = true;
  emitSecret();
  return secretTracks;
}

/**
 * Pull the account's switch at boot and hand it to the player service, so a
 * signed-in account with presence off never fires a request.
 */
export async function hydratePresenceSettings(): Promise<PresenceSettings> {
  const settings = await getPresenceSettings();
  await DiscordRpcService.setEnabled(settings.enabled);
  return settings;
}

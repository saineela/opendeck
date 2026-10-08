import { useSyncExternalStore } from "react";
import type { AudioQuality } from "../../../internal/audioQuality";
import { getAppSetting, setAppSetting } from "../../../internal/appSettings";
import { logInternalError, logInternalInfo, logInternalWarn } from "../../../internal/logging";
import type { StreamData } from "../../../datasource/DataSource";
import type { Playlist, Track } from "../../../datasource/types";
import { appErrorManager } from "../../../ui/errors/errorManager";
import { buildMediaStreamUrl } from "../../../platform/mediaStream";
import { isPluginEnabled } from "../../pluginHost";
import {
  hasDownloadBlob,
  readDownloadBlob,
  saveDownloadBlob,
} from "./downloadStorage";
import { DOWNLOADER_PLUGIN_ID } from "./manifest";

/**
 * Web implementation of the official downloader plugin. Streams are fetched
 * through the backend with progress reporting, persisted to IndexedDB for
 * offline playback, and handed to the browser's download manager so the file
 * lands in the user's Downloads folder (the desktop app wrote directly to a
 * chosen folder — the browser cannot write arbitrary paths).
 */

const MANIFEST_KEY = "plugin.downloader.manifest.v1";
const SETTINGS_KEY = "plugin.downloader.settings.v1";
const CHANGE_EVENT = "downloader-store-change";

type DownloadStatus = "absent" | "queued" | "downloading" | "paused" | "ready" | "failed";

interface DownloaderSettings {
  downloadPath: string | null;
  quality: AudioQuality;
}

export interface DownloadEntry {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  mimeType: string;
  filePath: string;
  byteLength: number;
  downloadedAt: number;
  artworkUrl?: string;
}

export interface DownloaderState {
  entries: Record<string, DownloadEntry>;
  queued: string[];
  pending: Record<string, Track>;
  downloadingId: string | null;
  progress: number | null;
  paused: boolean;
  failed: Record<string, string>;
  settings: DownloaderSettings;
  hydrating: boolean;
}

type StreamResolver = (track: Track, quality: AudioQuality) => Promise<{
  url: string;
  mimeType: string;
  cookie?: string;
}>;

type ActiveDownload = {
  trackId: string;
  controller: AbortController;
};

let activeDownload: ActiveDownload | null = null;

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function downloadFilename(track: Track, mimeType: string): string {
  const extension = mimeType.includes("webm")
    ? ".webm"
    : mimeType.includes("flac")
      ? ".flac"
      : mimeType.includes("mpeg")
        ? ".mp3"
        : ".m4a";
  const base = sanitizeFilenamePart(`${track.artist} - ${track.title}`) || track.id;
  return `${base}${extension}`;
}

function triggerBrowserSave(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
const listeners = new Set<() => void>();
const DEFAULT_SETTINGS: DownloaderSettings = {
  downloadPath: "Downloads",
  quality: "normal",
};

let state: DownloaderState = {
  entries: {},
  queued: [],
  pending: {},
  downloadingId: null,
  progress: null,
  paused: false,
  failed: {},
  settings: DEFAULT_SETTINGS,
  hydrating: true,
};
let resolver: StreamResolver | null = null;
let pumping = false;

function emit(): void {
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function setState(next: Partial<DownloaderState>): void {
  state = { ...state, ...next };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDownloaderState(): DownloaderState {
  return state;
}

export function useDownloaderState(): DownloaderState {
  return useSyncExternalStore(subscribe, getDownloaderState, getDownloaderState);
}

function parseRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function readManifest(): Record<string, DownloadEntry> {
  try {
    return parseRecord<DownloadEntry>(JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function writeManifest(entries: Record<string, DownloadEntry>): void {
  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(entries));
  } catch (error) {
    logInternalWarn("downloader.writeManifest localStorage failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void setAppSetting(MANIFEST_KEY, entries);
}

function readSettings(): DownloaderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    const value = parsed as Partial<DownloaderSettings>;
    return {
      downloadPath: typeof value.downloadPath === "string" && value.downloadPath.trim()
        ? value.downloadPath
        : null,
      quality: value.quality === "low" || value.quality === "high" ? value.quality : "normal",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: DownloaderSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  void setAppSetting(SETTINGS_KEY, settings);
}

function commitEntries(entries: Record<string, DownloadEntry>): void {
  writeManifest(entries);
  setState({ entries });
}

function reportDownloadFailure(track: Track, message: string): void {
  appErrorManager.report(`${track.title}: ${message}`, {
    title: "Download failed",
  });
}

function getDownloadErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isCancellationMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase();
  return normalized.includes("cancelled") || normalized.includes("canceled");
}

export async function hydrateDownloaderStore(): Promise<void> {
  let settings = readSettings();
  const durableSettings = await getAppSetting<DownloaderSettings>(SETTINGS_KEY);
  if (durableSettings && typeof durableSettings === "object") {
    settings = {
      downloadPath: typeof durableSettings.downloadPath === "string"
        ? durableSettings.downloadPath
        : settings.downloadPath,
      quality: durableSettings.quality === "low" || durableSettings.quality === "high"
        ? durableSettings.quality
        : durableSettings.quality === "normal"
          ? "normal"
          : settings.quality,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  const durableManifest = await getAppSetting<Record<string, DownloadEntry>>(MANIFEST_KEY);
  const manifest = { ...parseRecord<DownloadEntry>(durableManifest), ...readManifest() };

  setState({ settings, hydrating: false });
  await reconcileDownloads(manifest);
  startProgressFeed();
}

export function setDownloaderStreamResolver(nextResolver: StreamResolver): void {
  resolver = nextResolver;
}

export function getDownloadStatus(trackId: string): DownloadStatus {
  if (state.entries[trackId]) return "ready";
  if (state.downloadingId === trackId) return state.paused ? "paused" : "downloading";
  if (state.queued.includes(trackId)) return state.paused ? "paused" : "queued";
  if (state.failed[trackId]) return "failed";
  return "absent";
}

export function queueDownload(track: Track): void {
  if (!isPluginEnabled(DOWNLOADER_PLUGIN_ID) || track.source === "local") return;
  if (state.entries[track.id] || state.downloadingId === track.id || state.queued.includes(track.id)) return;
  const { [track.id]: _failed, ...failed } = state.failed;
  setState({
    queued: [...state.queued, track.id],
    pending: { ...state.pending, [track.id]: track },
    failed,
    paused: false,
  });
  void pump();
}

export function queueDownloads(tracks: Track[]): void {
  for (const track of tracks) queueDownload(track);
}

export function pauseDownloads(): void {
  setState({ paused: true });
  activeDownload?.controller.abort();
}

export function resumeDownloads(): void {
  if (!state.paused) return;
  setState({ paused: false });
  void pump();
}

export function togglePlaylistDownloads(tracks: Track[]): void {
  if (state.downloadingId || state.queued.length > 0) {
    if (state.paused) resumeDownloads();
    else pauseDownloads();
    return;
  }
  queueDownloads(tracks);
}

export async function setDownloadPath(downloadPath: string): Promise<void> {
  const settings = { ...state.settings, downloadPath };
  writeSettings(settings);
  setState({ settings });
}

export async function setDownloadQuality(quality: AudioQuality): Promise<void> {
  const settings = { ...state.settings, quality };
  writeSettings(settings);
  setState({ settings });
}

export async function rediscoverDownloads(): Promise<void> {
  // The desktop app rescanned the download folder; browsers cannot enumerate
  // the Downloads directory, so the stored manifest + IndexedDB blobs are the
  // source of truth. Reconcile against actual stored bytes instead.
  await reconcileDownloads(readManifest());
}

export function getDownloadedTracks(): Track[] {
  return Object.values(state.entries)
    .sort((left, right) => right.downloadedAt - left.downloadedAt)
    .map((entry) => ({
      id: entry.trackId,
      source: "youtube",
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      artworkUrl: entry.artworkUrl,
    }));
}

export async function getDownloaderPlaybackSource(track: Track): Promise<StreamData | null> {
  if (!isPluginEnabled(DOWNLOADER_PLUGIN_ID) || track.source !== "youtube") return null;
  const entry = state.entries[track.id];
  if (!entry) return null;
  try {
    const blob = await readDownloadBlob(track.id);
    if (!blob || blob.size === 0) {
      const { [track.id]: _missing, ...entries } = state.entries;
      commitEntries(entries);
      return null;
    }
    return { bytes: await blob.arrayBuffer(), mimeType: entry.mimeType || blob.type };
  } catch {
    const { [track.id]: _missing, ...entries } = state.entries;
    commitEntries(entries);
    return null;
  }
}

function startProgressFeed(): void {
  // Progress is reported directly from the fetch reader in `pump` on the web.
}

async function reconcileDownloads(manifest: Record<string, DownloadEntry>): Promise<void> {
  const entries: Record<string, DownloadEntry> = {};
  for (const [trackId, entry] of Object.entries(manifest)) {
    try {
      const exists = await hasDownloadBlob(trackId);
      if (exists) entries[trackId] = entry;
    } catch {
      // Keep the entry when storage checks fail; playback will re-validate.
      entries[trackId] = entry;
    }
  }
  commitEntries(entries);
}

async function pump(): Promise<void> {
  if (pumping || state.paused || state.downloadingId || state.queued.length === 0) return;
  if (!resolver) {
    logInternalWarn("downloader.pump missing stream resolver");
    return;
  }

  pumping = true;
  try {
    while (!state.paused && state.queued.length > 0) {
      const [trackId, ...rest] = state.queued;
      const track = state.pending[trackId];
      setState({ queued: rest, downloadingId: trackId, progress: null });
      if (!track) {
        setState({ downloadingId: null, progress: null });
        continue;
      }

      try {
        const stream = await resolver(track, state.settings.quality);
        logInternalInfo("downloader.download start", { trackId, title: track.title });

        const controller = new AbortController();
        activeDownload = { trackId, controller };
        const response = await fetch(buildMediaStreamUrl(stream.url), {
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Audio source returned HTTP ${response.status}.`);
        }

        const mimeType =
          stream.mimeType || response.headers.get("content-type") || "audio/mp4";
        const filename = downloadFilename(track, mimeType);
        const totalBytes = Number(response.headers.get("content-length") ?? 0);
        const chunks: BlobPart[] = [];
        let receivedBytes = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value.slice().buffer as ArrayBuffer);
            receivedBytes += value.byteLength;
            if (totalBytes > 0) {
              setState({
                progress: Math.max(1, Math.min(99, Math.round((receivedBytes / totalBytes) * 100))),
              });
            }
          }
          if (state.paused || activeDownload?.trackId !== trackId) {
            await reader.cancel().catch(() => undefined);
            throw new Error("Download cancelled.");
          }
        }
        activeDownload = null;

        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) {
          throw new Error("Audio download returned no data.");
        }
        await saveDownloadBlob(trackId, blob);
        triggerBrowserSave(blob, filename);

        const { [trackId]: _pending, ...pending } = state.pending;
        commitEntries({
          ...state.entries,
          [trackId]: {
            trackId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            mimeType,
            filePath: filename,
            byteLength: blob.size,
            downloadedAt: Date.now(),
            artworkUrl: track.artworkUrl,
          },
        });
        setState({ pending, downloadingId: null, progress: null });
      } catch (error) {
        activeDownload = null;
        const message = getDownloadErrorMessage(error);
        logInternalError("downloader.download failed", error, { trackId });
        if (state.paused && isCancellationMessage(message)) {
          setState({
            queued: [trackId, ...state.queued.filter((id) => id !== trackId)],
            downloadingId: null,
            progress: null,
          });
          continue;
        }

        const { [trackId]: _pending, ...pending } = state.pending;
        reportDownloadFailure(track, message);
        setState({
          pending,
          downloadingId: null,
          progress: null,
          failed: { ...state.failed, [trackId]: message },
        });
      }
    }
  } finally {
    pumping = false;
  }
}

export function getPlaylistDownloadSummary(_playlist: Playlist, tracks: Track[]): {
  total: number;
  downloaded: number;
  active: boolean;
  paused: boolean;
} {
  const ids = new Set(tracks.filter((track) => track.source !== "local").map((track) => track.id));
  return {
    total: ids.size,
    downloaded: [...ids].filter((id) => Boolean(state.entries[id])).length,
    active: Boolean(state.downloadingId && ids.has(state.downloadingId))
      || state.queued.some((id) => ids.has(id)),
    paused: state.paused,
  };
}

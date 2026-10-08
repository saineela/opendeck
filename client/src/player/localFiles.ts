/**
 * Web replacement for the desktop app's `local_audio_scan` / `local_audio_read`
 * Rust commands.
 *
 * Browsers cannot scan the filesystem, so local audio is registered through
 * the File System Access API (Chromium: persistent directory handles stored in
 * IndexedDB) with an `<input type="file">` fallback elsewhere. Track metadata
 * (paths) is mirrored to localStorage so local playlists keep listing their
 * contents across reloads even before file access is re-granted; playback
 * re-grants access on demand.
 */

export interface LocalAudioFile {
  path: string;
  title: string;
  album?: string;
  durationSec?: number;
}

export interface LocalAudioPayload {
  bytes: ArrayBuffer;
  mimeType: string;
}

const AUDIO_EXTENSION_REGEX = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|aiff?|wma)$/i;
const REGISTRY_STORAGE_KEY = "ytc-local-file-registry-v1";
const DIRECTORY_DB_NAME = "jamc-local-directories";
const DIRECTORY_STORE = "handles";

interface RegisteredFile {
  path: string;
  title: string;
  album?: string;
  directoryKey: string | null;
}

const liveFiles = new Map<string, File>();
let registeredFiles: RegisteredFile[] = [];
let registryLoaded = false;

function loadRegistry(): void {
  if (registryLoaded || typeof localStorage === "undefined") return;
  registryLoaded = true;
  try {
    const raw = localStorage.getItem(REGISTRY_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      registeredFiles = parsed.filter(
        (item): item is RegisteredFile =>
          Boolean(item) && typeof (item as RegisteredFile).path === "string",
      );
    }
  } catch {
    registeredFiles = [];
  }
}

function saveRegistry(): void {
  try {
    localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(registeredFiles));
  } catch {
    // Registry persistence is best-effort; the session registry still works.
  }
}

function baseName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

function titleFromPath(path: string): string {
  const name = baseName(path).replace(AUDIO_EXTENSION_REGEX, "");
  return name || baseName(path);
}

function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSION_REGEX.test(name);
}

function registerFile(file: File, path: string, directoryKey: string | null): void {
  liveFiles.set(path, file);
  const existing = registeredFiles.findIndex((entry) => entry.path === path);
  const entry: RegisteredFile = {
    path,
    title: titleFromPath(path),
    directoryKey,
  };
  if (existing >= 0) registeredFiles[existing] = { ...registeredFiles[existing], ...entry };
  else registeredFiles.push(entry);
}

function toLocalAudioFile(entry: RegisteredFile): LocalAudioFile {
  return { path: entry.path, title: entry.title, album: entry.album };
}

/* --------------------------- Directory handles --------------------------- */

function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function openDirectoryDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DIRECTORY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIRECTORY_STORE)) {
        db.createObjectStore(DIRECTORY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function saveDirectoryHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDirectoryDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DIRECTORY_STORE, "readwrite");
    tx.objectStore(DIRECTORY_STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

async function loadDirectoryHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDirectoryDb();
  if (!db) return null;
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    const tx = db.transaction(DIRECTORY_STORE, "readonly");
    const request = tx.objectStore(DIRECTORY_STORE).get(key);
    request.onsuccess = () =>
      resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}

async function walkDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  directoryKey: string,
  onFile: (file: File, path: string) => void,
): Promise<void> {
  // FileSystemDirectoryHandle iteration via async iterator (Chromium).
  const entries = directory as unknown as AsyncIterable<
    [string, FileSystemHandle]
  > & FileSystemDirectoryHandle;
  for await (const [name, handle] of entries) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      const file = await (handle as FileSystemFileHandle).getFile();
      if (isAudioFile(name)) onFile(file, path);
    } else if (handle.kind === "directory") {
      await walkDirectory(handle as FileSystemDirectoryHandle, path, directoryKey, onFile);
    }
  }
}

/**
 * Opens a folder picker and registers every audio file below it.
 * Returns the registered entries (existing playlist paths keep working).
 */
export async function pickLocalAudioDirectory(): Promise<LocalAudioFile[]> {
  if (!supportsDirectoryPicker()) {
    throw new Error(
      "Folder access is not available in this browser. Use “Add audio files” instead.",
    );
  }
  const directory = await window.showDirectoryPicker({ mode: "read" });
  const directoryKey = directory.name;
  await saveDirectoryHandle(directoryKey, directory);

  let count = 0;
  await walkDirectory(directory, directory.name, directoryKey, (file, path) => {
    registerFile(file, path, directoryKey);
    count += 1;
  });
  if (count === 0) {
    throw new Error(`No audio files found in “${directory.name}”.`);
  }
  saveRegistry();
  registryLoaded = true;
  return registeredFiles
    .filter((entry) => entry.path.startsWith(`${directory.name}/`))
    .map(toLocalAudioFile);
}

/** Fallback picker using a plain file input (all browsers). */
export function pickLocalAudioFiles(): Promise<LocalAudioFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus,.webm";
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        reject(new Error("No files selected."));
        return;
      }
      for (const file of files) {
        registerFile(file, file.name, null);
      }
      saveRegistry();
      registryLoaded = true;
      resolve(files.map((file) => toLocalAudioFile({ path: file.name, title: titleFromPath(file.name), directoryKey: null })));
    });
    input.click();
  });
}

/**
 * Mirrors the original `local_audio_scan(paths)` command: list audio files
 * under the given folder paths. Includes files registered in previous
 * sessions even if their bytes are not accessible yet (playback re-grants
 * access on demand).
 */
export async function scanLocalAudio(paths: string[]): Promise<LocalAudioFile[]> {
  loadRegistry();
  if (paths.length === 0) {
    return registeredFiles.map(toLocalAudioFile);
  }
  const matched = registeredFiles.filter((entry) =>
    paths.some(
      (rawPath) => {
        const path = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
        return entry.path === path || entry.path.startsWith(`${path}/`);
      },
    ),
  );
  return matched.map(toLocalAudioFile);
}

async function rehydrateFile(path: string): Promise<File | null> {
  const entry = registeredFiles.find((item) => item.path === path);
  if (!entry?.directoryKey || !supportsDirectoryPicker()) return null;

  const directory = await loadDirectoryHandle(entry.directoryKey);
  if (!directory) return null;

  try {
    const permission = await (directory as FileSystemDirectoryHandle & {
      queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
      requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
    }).queryPermission?.({ mode: "read" });
    if (permission !== "granted") {
      const result = await (directory as FileSystemDirectoryHandle & {
        requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
      }).requestPermission?.({ mode: "read" });
      if (result !== "granted") return null;
    }

    const segments = entry.path.split("/");
    let current: FileSystemDirectoryHandle = directory;
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = await current.getDirectoryHandle(segments[index]);
    }
    const fileHandle = await current.getFileHandle(segments[segments.length - 1]);
    const file = await fileHandle.getFile();
    liveFiles.set(path, file);
    return file;
  } catch {
    return null;
  }
}

/** Mirrors the original `local_audio_read(path)` command. */
export async function readLocalAudio(path: string): Promise<LocalAudioPayload | null> {
  loadRegistry();
  let file = liveFiles.get(path) ?? (await rehydrateFile(path));
  if (!file) return null;
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return null;
  const mimeType = file.type || guessMimeType(path);
  return { bytes, mimeType };
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "audio/mp4";
}

export function hasRegisteredLocalFiles(): boolean {
  loadRegistry();
  return registeredFiles.length > 0;
}

export function supportsPersistentLocalFiles(): boolean {
  return supportsDirectoryPicker();
}

declare global {
  interface Window {
    showDirectoryPicker(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
}

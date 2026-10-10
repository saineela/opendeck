/**
 * IndexedDB blob store for downloaded tracks — the web equivalent of files
 * saved to disk by the desktop app's downloader. Persisting the bytes lets
 * saved tracks play offline through the player's native-audio path. Nothing is
 * handed to the browser's download manager — offline audio stays inside
 * app-managed storage, never in the user's Downloads folder.
 */

const DB_NAME = "jamc-downloads";
const STORE = "audio";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function saveDownloadBlob(trackId: string, blob: Blob): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const stored = await new Promise<boolean>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, trackId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
  db.close();
  return stored;
}

export async function readDownloadBlob(trackId: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(trackId);
    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return blob;
}

export async function hasDownloadBlob(trackId: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const exists = await new Promise<boolean>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).count(trackId);
    request.onsuccess = () => resolve(Number(request.result) > 0);
    request.onerror = () => resolve(false);
  });
  db.close();
  return exists;
}

export async function deleteDownloadBlob(trackId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(trackId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

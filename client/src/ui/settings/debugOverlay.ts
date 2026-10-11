import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

/**
 * Admin-only "Debug" switch (Settings → Admin).
 *
 * When on, a panel renders over every page showing what that page is pulling
 * from our own caches rather than from Google: which artwork came from
 * `/api/artwork`, the server's JSON and image cache totals, the browser-side
 * localStorage/IndexedDB stores, and the offline-audio entries.
 *
 * The switch lives in durable app settings, so it follows the admin's
 * account across devices. It is deliberately **not** an instance-wide flag:
 * the panel exposes cache internals, so only the account that turned it on
 * ever sees it — a second admin on the same instance gets their own switch.
 */
const DEBUG_OVERLAY_STORAGE_KEY = "debug-overlay-enabled";
const CHANGE_EVENT = "debug-overlay-change";

function readDebugOverlay() {
  return readLocalBooleanSetting(DEBUG_OVERLAY_STORAGE_KEY, false);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setDebugOverlayEnabled(enabled: boolean) {
  writeLocalBooleanSetting(DEBUG_OVERLAY_STORAGE_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateDebugOverlaySetting() {
  await hydrateLocalBooleanSetting(DEBUG_OVERLAY_STORAGE_KEY, false, CHANGE_EVENT);
}

export function useDebugOverlayEnabled() {
  return useSyncExternalStore(subscribe, readDebugOverlay, () => false);
}

import { logInternalWarn } from "./logging";

/**
 * Web replacement for the desktop app's durable `app_setting_*` commands.
 * Settings are persisted per signed-in account on the server; when signed out,
 * callers fall back to localStorage (mirroring the original dual-write
 * pattern via `durableLocalSetting`).
 */

/**
 * Remote durability only exists for signed-in users. Once the server tells
 * us we are signed out (401) we stop calling it until the auth state says
 * otherwise, so boot does not spray expected 401s through the console.
 */
let remoteState: "unknown" | "enabled" | "disabled" = "unknown";

/** Resolved the first time the auth session probe reports a verdict. */
let readyResolve: (() => void) | null = null;
const remoteReady = new Promise<void>((resolve) => {
  readyResolve = resolve;
});
let readySettled = false;

export function setSettingsRemoteAvailability(authenticated: boolean): void {
  remoteState = authenticated ? "enabled" : "disabled";
  if (!readySettled) {
    readySettled = true;
    readyResolve?.();
  }
}

/**
 * Wait (bounded) for the first auth verdict so mount does not race it,
 * then report the current availability.
 */
async function waitForAuthVerdict(): Promise<"unknown" | "enabled" | "disabled"> {
  if (!readySettled) {
    await Promise.race([
      remoteReady,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  return remoteState;
}
async function postSettings<T>(path: string, payload: Record<string, unknown>): Promise<T | null> {
  if (remoteState === "disabled") return null;
  if ((await waitForAuthVerdict()) === "disabled") return null;
  try {
    const response = await fetch(`/api/settings/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      remoteState = "disabled";
      // Signed out: durable persistence unavailable; localStorage remains the
      // source of truth until the user signs in again.
      return null;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    remoteState = "enabled";
    return (await response.json()) as T;
  } catch (error) {
    logInternalWarn(`appSetting.${path} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getAppSetting<T>(key: string): Promise<T | null> {
  const result = await postSettings<{ value: T | null }>("get", { key });
  return result?.value ?? null;
}

export async function setAppSetting<T>(key: string, value: T): Promise<void> {
  await postSettings("set", { key, value });
}

export async function removeAppSetting(key: string): Promise<void> {
  await postSettings("remove", { key });
}

export async function clearAppSettings(): Promise<void> {
  if (remoteState === "disabled") return;
  if ((await waitForAuthVerdict()) === "disabled") return;
  const response = await fetch("/api/settings/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (response.ok || response.status === 401) return;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `HTTP ${response.status}`);
}

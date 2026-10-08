import { useSyncExternalStore } from "react";
import { logInternalWarn } from "../internal/logging";
import { setSettingsRemoteAvailability } from "../internal/appSettings";

/**
 * Google Sign-In state for the web app.
 *
 * The flow: `signInWithGoogle` opens our backend's `/api/auth/google/start`
 * in a popup, which redirects through Google's OAuth consent screen and comes
 * back to `/api/auth/google/callback`. The callback page postMessages the
 * opener and closes itself; we also poll the session endpoint as a fallback
 * (popup blockers, mobile browsers). Tokens and the session cookie live
 * exclusively on the server.
 */

export interface AuthUser {
  name: string;
  email: string | null;
  picture: string | null;
}

export interface AuthSession {
  authenticated: boolean;
  user: AuthUser | null;
  youtubeLinked: boolean;
}

export type AuthStatus = "loading" | "signed-out" | "signed-in";

const SIGNED_OUT: AuthSession = { authenticated: false, user: null, youtubeLinked: false };

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

let session: AuthSession = SIGNED_OUT;
let status: AuthStatus = "loading";
let lastError: string | null = null;
let refreshPromise: Promise<AuthSession> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthSnapshot(): AuthSession {
  return session;
}

export function getAuthStatusSnapshot(): AuthStatus {
  return status;
}

export function getAuthErrorSnapshot(): string | null {
  return lastError;
}

export function useAuth(): {
  session: AuthSession;
  status: AuthStatus;
  error: string | null;
  refresh: () => Promise<AuthSession>;
} {
  const current = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
  const currentStatus = useSyncExternalStore(subscribeAuth, getAuthStatusSnapshot, getAuthStatusSnapshot);
  const currentError = useSyncExternalStore(subscribeAuth, getAuthErrorSnapshot, getAuthErrorSnapshot);
  return {
    session: current,
    status: currentStatus,
    error: currentError,
    refresh: refreshAuthSession,
  };
}

export async function refreshAuthSession(): Promise<AuthSession> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch("/api/auth/session", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Session check failed with HTTP ${response.status}.`);
      const payload = (await response.json()) as AuthSession;
      session = {
        authenticated: Boolean(payload.authenticated),
        user: payload.user ?? null,
        youtubeLinked: Boolean(payload.youtubeLinked),
      };
      status = session.authenticated ? "signed-in" : "signed-out";
    setSettingsRemoteAvailability(session.authenticated);
      lastError = null;
    } catch (error) {
      logInternalWarn("auth.refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Network failure: keep previous session state but stop showing "loading".
      if (status === "loading") status = "signed-out";
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshPromise = null;
      emit();
    }
    return session;
  })();
  return refreshPromise;
}

export function applyAuthSession(next: AuthSession): void {
  session = next;
  status = next.authenticated ? "signed-in" : "signed-out";
  emit();
}

function waitForAuthMessage(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Google sign-in timed out."));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { jamcAuth?: boolean; ok?: boolean } | null;
      if (!data || data.jamcAuth !== true) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      if (data.ok === false) {
        reject(new Error("Google sign-in was cancelled or failed."));
      } else {
        resolve();
      }
    }

    window.addEventListener("message", onMessage);
  });
}

async function pollUntilAuthenticated(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    const latest = await refreshAuthSession();
    if (latest.authenticated) return;
  }
  throw new Error("Google sign-in timed out.");
}

/**
 * Runs the Google OAuth popup flow and resolves once the session exists.
 * Falls back to a full-page redirect when popups are blocked.
 */
export async function signInWithGoogle(): Promise<AuthSession> {
  const startUrl = `/api/auth/google/start?returnTo=${encodeURIComponent(
    window.location.pathname + window.location.search,
  )}`;
  const popup = window.open(startUrl, "jamc-google-signin", "width=520,height=640");

  if (!popup) {
    // Popup blocked — fall back to a top-level redirect. The callback page
    // redirects back here after sign-in completes.
    window.location.assign(startUrl);
    return session;
  }

  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  try {
    await Promise.race([
      waitForAuthMessage(Math.max(1000, deadline - Date.now())),
      pollUntilAuthenticated(deadline),
    ]);
  } finally {
    if (!popup.closed) popup.close();
  }
  return refreshAuthSession();
}

export async function signOut(): Promise<void> {
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    if (!response.ok && response.status !== 401) {
      throw new Error(`Sign-out failed with HTTP ${response.status}.`);
    }
  } finally {
    applyAuthSession(SIGNED_OUT);
  }
}

/* ----------------------------------------------------------------------
 * YouTube Music account linking (Google device-code OAuth, server-side).
 * -------------------------------------------------------------------- */

export interface YouTubeLinkStatus {
  state: "idle" | "pending" | "linked" | "error";
  linked: boolean;
  verificationUrl?: string;
  userCode?: string;
  expiresInSec?: number;
  error?: string;
}

async function postYouTube(path: string): Promise<YouTubeLinkStatus> {
  const response = await fetch(`/api/youtube/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `YouTube sign-in request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as YouTubeLinkStatus;
}

export async function getYouTubeLinkStatus(): Promise<YouTubeLinkStatus> {
  const response = await fetch("/api/youtube/status", {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    if (response.status === 401) return { state: "idle", linked: false };
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `YouTube sign-in status failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as YouTubeLinkStatus;
}

export function startYouTubeLink(): Promise<YouTubeLinkStatus> {
  return postYouTube("link");
}

export function cancelYouTubeLink(): Promise<YouTubeLinkStatus> {
  return postYouTube("cancel");
}

export async function unlinkYouTube(): Promise<void> {
  await postYouTube("unlink");
}

export async function refreshYouTubeLinkedFlag(): Promise<void> {
  // The endpoint requires a session; skip it entirely while signed out.
  if (!session.authenticated) return;
  const status = await getYouTubeLinkStatus();
  applyAuthSession({ ...session, youtubeLinked: status.linked });
}

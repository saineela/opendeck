import { useSyncExternalStore } from "react";
import { logInternalWarn } from "../internal/logging";
import { setSettingsRemoteAvailability } from "../internal/appSettings";

/**
 * Google Sign-In state for the web app.
 *
 * The flow is a cross-device QR handoff: `startGoogleQrSignIn` creates a
 * short-lived attempt on our backend and the login page renders its link as
 * a QR code. The phone scans it and runs Google's consent; the callback marks
 * the attempt complete (the phone never receives a session). Back on the
 * desktop, the user presses Verify — `verifyGoogleQrSignIn` claims the
 * completed attempt and this browser receives the session cookie. Tokens and
 * the session cookie live exclusively on the server.
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
  /** True when the signed-in account has TOTP second-factor enabled. */
  totpEnabled: boolean;
  /** "password" | "google" — which credential opened this session. */
  authProvider: string | null;
  /** Whether this server allows email + password accounts at all. */
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
  /** Whether a Google OAuth client is configured on this server. */
  googleSignInEnabled: boolean;
  /** Whether sign-up requires an invite code. */
  inviteCodeRequired: boolean;
  /** Role of the signed-in account; null when signed out. */
  role: "admin" | "user" | null;
  /** True while the instance has no accounts — show first-run setup. */
  needsSetup: boolean;
  /** Display name + availability of the configured OIDC provider. */
  oauthProvider: { name: string; configured: boolean };
}

export type AuthStatus = "loading" | "signed-out" | "signed-in";

const SIGNED_OUT: AuthSession = {
  authenticated: false,
  user: null,
  youtubeLinked: false,
  totpEnabled: false,
  authProvider: null,
  passwordLoginEnabled: true,
  registrationEnabled: true,
  googleSignInEnabled: false,
  inviteCodeRequired: false,
  role: null,
  needsSetup: false,
  oauthProvider: { name: "Google", configured: false },
};

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
      const payload = (await response.json()) as Partial<AuthSession>;
      session = {
        authenticated: Boolean(payload.authenticated),
        user: payload.user ?? null,
        youtubeLinked: Boolean(payload.youtubeLinked),
        totpEnabled: Boolean(payload.totpEnabled),
        authProvider: payload.authProvider ?? null,
        passwordLoginEnabled: payload.passwordLoginEnabled !== false,
        registrationEnabled: payload.registrationEnabled !== false,
        googleSignInEnabled: Boolean(payload.googleSignInEnabled),
        inviteCodeRequired: Boolean(payload.inviteCodeRequired),
        role: payload.role === "admin" || payload.role === "user" ? payload.role : null,
        needsSetup: Boolean(payload.needsSetup),
        oauthProvider: {
          name: payload.oauthProvider?.name || "Google",
          configured: Boolean(payload.oauthProvider?.configured),
        },
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

/* ----------------------------------------------------------------------
 * Cross-device Google sign-in (QR handoff).
 * -------------------------------------------------------------------- */

export interface GoogleQrSignIn {
  attemptId: string;
  /** Encode this link as a QR code; the phone opens it to run the consent. */
  qrUrl: string;
  expiresInSec: number;
}

export type GoogleQrVerifyResult =
  | { status: "pending" }
  | { status: "verified"; user: AuthUser };

/** Creates a sign-in attempt; render `qrUrl` as a QR code on the desktop. */
export function startGoogleQrSignIn(): Promise<GoogleQrSignIn> {
  return postJson<GoogleQrSignIn>("/api/auth/google/qr/start", {});
}

/**
 * The Verify button. Claims the attempt once the phone has finished the
 * consent — on success this browser receives the session cookie.
 */
export async function verifyGoogleQrSignIn(
  attemptId: string,
): Promise<GoogleQrVerifyResult> {
  const result = await postJson<GoogleQrVerifyResult>("/api/auth/google/qr/verify", {
    attemptId,
  });
  if (result.status === "verified") await refreshAuthSession();
  return result;
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
 * Local accounts: email + password, with an optional TOTP second factor.
 * -------------------------------------------------------------------- */

export interface TotpChallenge {
  status: "totp_required";
  challenge: string;
  expiresInSeconds: number;
}

export interface TotpStatus {
  enabled: boolean;
  enrolled: boolean;
  backupCodesRemaining: number;
}

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
  issuer: string;
  digits: number;
  periodSeconds: number;
}

export interface PasswordLoginResult {
  status: "ok" | "totp_required";
  challenge?: string;
  expiresInSeconds?: number;
}

async function postJson<T>(pathname: string, body: unknown): Promise<T> {
  const response = await fetch(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error ?? `Request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}

export function registerAccount(input: {
  email: string;
  password: string;
  name?: string;
  inviteCode?: string;
}): Promise<{ ok: boolean; user: AuthUser }> {
  return postJson("/api/auth/register", input);
}

/**
 * Password sign-in. Resolves `totp_required` when the account has a second
 * factor — pass the returned challenge to `completeTotpLogin`.
 */
export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<PasswordLoginResult> {
  const result = await postJson<PasswordLoginResult>("/api/auth/login", input);
  if (result.status === "ok") await refreshAuthSession();
  return result;
}

export async function completeTotpLogin(input: {
  challenge: string;
  code: string;
}): Promise<PasswordLoginResult> {
  const result = await postJson<PasswordLoginResult>("/api/auth/login/totp", input);
  await refreshAuthSession();
  return result;
}

export async function getTotpStatus(): Promise<TotpStatus> {
  const response = await fetch("/api/auth/totp/status", {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Unable to load two-step status.");
  return (await response.json()) as TotpStatus;
}

export function setupTotp(): Promise<TotpSetup> {
  return postJson<TotpSetup>("/api/auth/totp/setup", {});
}

export async function enableTotp(code: string): Promise<{ enabled: boolean; backupCodes: string[] }> {
  const result = await postJson<{ enabled: boolean; backupCodes: string[] }>("/api/auth/totp/enable", { code });
  await refreshAuthSession();
  return result;
}

export async function disableTotp(input: { password: string; code: string }): Promise<{ enabled: boolean }> {
  const result = await postJson<{ enabled: boolean }>("/api/auth/totp/disable", input);
  await refreshAuthSession();
  return result;
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

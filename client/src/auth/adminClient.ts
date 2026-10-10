/**
 * Admin panel API (`/api/admin/*`).
 *
 * Every route requires a real browser session on an admin account (the
 * server answers 401 for anonymous/bearer callers and 403 for non-admins),
 * and the instance reset additionally demands a fresh TOTP code.
 */

export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: "admin" | "user";
  authProvider: string;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number;
}

export interface AdminOverview {
  users: number;
  admins: number;
  sessions: number;
  apiKeys: number;
  cacheEntries: number;
  settings: number;
}

export interface OAuthProviderConfig {
  providerName: string;
  discoveryUrl: string;
  clientId: string;
  /** True when an effective secret exists — the value itself is write-only. */
  clientSecretSet: boolean;
  configured: boolean;
  source: "instance" | "env" | "none";
}

export interface ResetResult {
  ok: true;
  settingsCleared: number;
  cacheCleared: number;
  sessionsRevoked: number;
}

async function requestJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin${pathname}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Admin request failed with HTTP ${response.status}.`);
  }
  return payload as unknown as T;
}

export function getOverview(): Promise<AdminOverview> {
  return requestJson<AdminOverview>("/overview");
}

export async function listUsers(): Promise<AdminUser[]> {
  const payload = await requestJson<{ users: AdminUser[] }>("/users");
  return payload.users;
}

export function createAdminUser(input: {
  email: string;
  password: string;
  name?: string;
  role?: "admin" | "user";
}): Promise<{ user: AdminUser }> {
  return requestJson<{ user: AdminUser }>("/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function setUserRole(id: string, role: "admin" | "user"): Promise<{ user: AdminUser }> {
  return requestJson<{ user: AdminUser }>(`/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function revokeUserSessions(id: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(`/users/${encodeURIComponent(id)}/logout`, {
    method: "POST",
    body: "{}",
  });
}

export function resetUserTotp(id: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(`/users/${encodeURIComponent(id)}/totp-reset`, {
    method: "POST",
    body: "{}",
  });
}

export function deleteAdminUser(id: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getOAuthConfig(): Promise<{ provider: OAuthProviderConfig }> {
  return requestJson<{ provider: OAuthProviderConfig }>("/oauth");
}

export function saveOAuthConfig(input: {
  providerName?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ provider: OAuthProviderConfig }> {
  return requestJson<{ provider: OAuthProviderConfig }>("/oauth", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export interface RegistrationConfig {
  enabled: boolean;
  /** True once an admin flipped the switch away from the env baseline. */
  overridden: boolean;
  /** What ALLOW_REGISTRATION resolved to at boot. */
  envDefault: boolean;
  inviteCodeRequired: boolean;
}

/** Public account creation: read or flip the runtime switch. */
export function getRegistrationConfig(): Promise<{ registration: RegistrationConfig }> {
  return requestJson<{ registration: RegistrationConfig }>("/registration");
}

export function setRegistrationConfig(
  enabled: boolean,
): Promise<{ registration: RegistrationConfig }> {
  return requestJson<{ registration: RegistrationConfig }>("/registration", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

/** Instance-wide data reset — the server requires a fresh TOTP code. */
export function resetAppData(totpCode: string): Promise<ResetResult> {
  return requestJson<ResetResult>("/reset", {
    method: "POST",
    body: JSON.stringify({ totpCode }),
  });
}

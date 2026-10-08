import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ServerConfig } from "../config.js";

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface GoogleProfile {
  sub: string;
  name: string;
  email?: string;
  picture?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

let discoveryPromise: Promise<DiscoveryDocument> | null = null;

async function fetchDiscovery(config: ServerConfig): Promise<DiscoveryDocument> {
  const response = await fetch(config.google.discoveryUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Google discovery document request failed with HTTP ${response.status}.`);
  }
  const doc = (await response.json()) as DiscoveryDocument;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("Google discovery document is missing required endpoints.");
  }
  return doc;
}

export function getDiscovery(config: ServerConfig): Promise<DiscoveryDocument> {
  if (!discoveryPromise) {
    discoveryPromise = fetchDiscovery(config).catch((error) => {
      discoveryPromise = null;
      throw error;
    });
  }
  return discoveryPromise;
}

/** Test hook: reset cached discovery between test cases. */
export function resetDiscoveryCache(): void {
  discoveryPromise = null;
  jwksCache.clear();
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(config: ServerConfig, uri: string) {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri), {
      timeoutDuration: 10_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 60 * 60 * 1000,
    });
    jwksCache.set(uri, jwks);
    void config;
  }
  return jwks;
}

export function buildAuthorizeUrl(
  config: ServerConfig,
  discovery: DiscoveryDocument,
  params: { state: string; codeChallenge: string; redirectUri: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.google.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCode(
  config: ServerConfig,
  discovery: DiscoveryDocument,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok || payload.error) {
    throw new Error(
      `Google token exchange failed: ${payload.error ?? `HTTP ${response.status}`} ${payload.error_description ?? ""}`.trim(),
    );
  }
  if (!payload.access_token) {
    throw new Error("Google token exchange returned no access token.");
  }
  return payload;
}

export async function verifyIdToken(
  config: ServerConfig,
  discovery: DiscoveryDocument,
  idToken: string,
): Promise<GoogleProfile> {
  const jwks = getJwks(config, discovery.jwks_uri);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: discovery.issuer,
    audience: config.google.clientId,
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Google ID token is missing a subject.");
  }
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" && payload.name ? payload.name : (payload.email as string | undefined) ?? "Google user",
    email: typeof payload.email === "string" ? payload.email : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}

export async function refreshToken(
  config: ServerConfig,
  discovery: DiscoveryDocument,
  refreshTokenValue: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: refreshTokenValue,
    grant_type: "refresh_token",
  });
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as TokenResponse & { error?: string };
  if (!response.ok || payload.error || !payload.access_token) {
    throw new Error(`Google token refresh failed: ${payload.error ?? `HTTP ${response.status}`}`);
  }
  return payload;
}

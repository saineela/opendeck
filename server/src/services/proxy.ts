import { logger } from "../logger.js";
import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { getValidAccessToken } from "./youtubeAccount.js";
import { fetchAllowlisted } from "./safeFetch.js";

/**
 * Server-side replacement for the original app's Tauri `proxy_http_request`
 * command. The browser cannot call YouTube/InnerTube directly (CORS), so the
 * client sends requests here, which forwards them server-side and returns the
 * raw response.
 *
 * Security boundaries:
 *  - HTTPS only, strict host allowlist (no open proxy).
 *  - Client-supplied Cookie/Authorization/Origin/Referer headers are dropped.
 *  - When the signed-in user has a linked YouTube account, a valid OAuth
 *    Bearer token is injected for InnerTube/stat endpoints (replacing the
 *    desktop app's SAPISID cookie auth). Tokens never reach the browser.
 */

const DEFAULT_ALLOWED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "music.youtube.com",
  "m.youtube.com",
  "youtubei.googleapis.com",
  "googlevideo.com",
  "ytimg.com",
  "i.ytimg.com",
  "googleusercontent.com",
  "ggpht.com",
  "lrclib.net",
  "api.lrclib.net",
  "lyrics-api.boidu.dev",
  "fonts.gstatic.com",
  "fonts.googleapis.com",
  // youtubei.js probes https://cp.cloudflare.com/generate_204 on boot to
  // detect connectivity; harmless GET with no credentials.
  "cp.cloudflare.com",
];

const STRIPPED_REQUEST_HEADERS = new Set([
  "cookie",
  "authorization",
  "origin",
  "referer",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
]);

const MAX_PROXY_BODY_BYTES = 64 * 1024 * 1024;

export interface ProxyRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body_base64?: string;
  timeout_ms?: number;
}

export interface ProxyResponseOutput {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
}

let extraHosts: string[] = [];

export function configureProxyHosts(config: ServerConfig): void {
  const fromEnv = (process.env.YT_PROXY_EXTRA_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  extraHosts = fromEnv;
  void config;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function isHostAllowed(rawUrl: URL): boolean {
  if (rawUrl.protocol !== "https:") return false;
  const host = normalizeHost(rawUrl.hostname);
  if (host === "localhost" || host === "127.0.0.1") return false;
  const candidates = [...DEFAULT_ALLOWED_HOSTS, ...extraHosts];
  return candidates.some((allowed) => {
    const normalized = normalizeHost(allowed);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function needsBearerAuth(url: URL): boolean {
  if (url.hostname !== "youtube.com" && !url.hostname.endsWith(".youtube.com")) return false;
  return (
    url.pathname.startsWith("/youtubei/")
    || url.pathname.startsWith("/api/stats/")
    || url.pathname.startsWith("/youtubei")
  );
}

export interface ForwardResult extends ProxyResponseOutput {}

export async function forwardProxyRequest(
  db: Db,
  config: ServerConfig,
  input: ProxyRequestInput,
  userId: string | null,
): Promise<ProxyResult> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { ok: false, status: 400, error: "Invalid URL." };
  }

  if (!isHostAllowed(url)) {
    logger.warn("proxy.blocked_host", { host: url.hostname, pathname: url.pathname });
    return { ok: false, status: 403, error: `Host not allowed: ${url.hostname}` };
  }

  const method = (input.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "HEAD", "PUT", "DELETE"].includes(method)) {
    return { ok: false, status: 400, error: `Method not allowed: ${method}` };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (typeof value === "string") headers[lower] = value;
  }

  let body: Buffer | undefined;
  if (input.body_base64) {
    try {
      body = Buffer.from(input.body_base64, "base64");
    } catch {
      return { ok: false, status: 400, error: "Invalid body_base64." };
    }
  }

  const timeoutMs = Math.min(Math.max(input.timeout_ms ?? 30_000, 1_000), 120_000);
  const baseInit: RequestInit = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs),
  };

  // Resolved once; `prepare` below re-scopes it per hop so the token is only
  // ever attached to youtube.com endpoints that need it — never carried
  // across a redirect to another (even allowlisted) origin.
  const bearerToken = userId ? await getValidAccessToken(db, config, userId) : null;

  let response: Response;
  try {
    response = await fetchAllowlisted(url, baseInit, {
      isAllowed: isHostAllowed,
      prepare: (hopUrl, init) => {
        if (!bearerToken || !needsBearerAuth(hopUrl)) return init;
        return {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            authorization: `Bearer ${bearerToken}`,
            // InnerTube refuses account-scoped calls (library browse, liked
            // songs, history) with a bare Bearer token — it also requires
            // X-Goog-AuthUser, same as the SAPISID cookie flow. The device
            // code link binds exactly one Google account, so index 0.
            "x-goog-authuser": "0",
            "x-goog-request-time": String(Math.floor(Date.now() / 1000)),
          },
        };
      },
    });
  } catch (error) {
    logger.warn("proxy.forward failed", {
      host: url.hostname,
      pathname: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 502, error: "Upstream request failed." };
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) {
    return { ok: false, status: 502, error: "Upstream response too large." };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_PROXY_BODY_BYTES) {
    return { ok: false, status: 502, error: "Upstream response too large." };
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!STRIPPED_RESPONSE_HEADERS.has(lower)) responseHeaders[lower] = value;
  });

  return {
    ok: true,
    status: response.status,
    output: {
      status: response.status,
      headers: responseHeaders,
      body_base64: buffer.toString("base64"),
    },
  };
}

export type ProxyResult =
  | { ok: true; status: number; output: ProxyResponseOutput }
  | { ok: false; status: number; error: string };

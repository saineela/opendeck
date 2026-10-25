import type { Db } from "../db.js";
import type { ServerConfig } from "../config.js";
import { getValidAccessToken } from "./youtubeAccount.js";
import { buildYouTubeCookieHeaders, loadYouTubeCookies } from "./youtubeCookies.js";
import { logger } from "../logger.js";

/**
 * Playback URL resolution for YouTube Music.
 *
 * The gated catalogue (`LOGIN_REQUIRED — Sign in to confirm you're not a bot`)
 * is not defeated by an OAuth token: YouTube only accepts OAuth on TVHTML5,
 * and TVHTML5 refuses to hand out stream URLs without a BotGuard attestation
 * that a headless server cannot produce. What does work — and what the JAMC
 * desktop app relies on — is a **real signed-in web session**:
 *
 *   SAPISIDHASH request signing + the visitor data the web client uses, on
 *   `music.youtube.com` with `WEB_REMIX`.
 *
 * A browser cannot share its youtube.com cookies with this origin, so the user
 * imports the cookie header once (Settings → Playback sign-in). This module
 * then signs requests exactly like the web client, and falls back in order:
 *
 *   1. cookies    WEB_REMIX (and WEB) signed with SAPISIDHASH
 *   2. tv         TVHTML5 with the linked account's OAuth Bearer
 *   3. anonymous  ANDROID_VR / IOS, which serve plain URLs for public videos
 *
 * Every attempt is recorded so the UI can explain *which* credential is
 * missing instead of a generic "playback failed".
 */

const REQUEST_TIMEOUT_MS = 25_000;
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IOS_UA =
  "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_10 like Mac OS X)";
const VR_UA =
  "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";
const TV_UA = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";

export type PlaybackQuality = "normal" | "high";

export interface ResolvedPlayback {
  url: string;
  mimeType: string;
  itag: number | null;
  /** Which credential produced the URL ("cookies", "tv", "anonymous"). */
  via: PlaybackCredential;
}

export type PlaybackCredential = "cookies" | "tv" | "anonymous";

export interface PlaybackAttempt {
  credential: PlaybackCredential;
  client: string;
  playability: string;
  reason?: string;
  audioFormats: number;
  playableFormats: number;
}

export type PlaybackResolution =
  | { ok: true; playback: ResolvedPlayback }
  | { ok: false; status: number; reason: string; attempts: PlaybackAttempt[] };

interface PlayerFormat {
  itag?: number;
  mimeType?: string;
  bitrate?: number;
  url?: string;
  signatureCipher?: string;
  cipher?: string;
  drmFamilies?: unknown;
  fairPlayKeyUri?: unknown;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: PlayerFormat[]; formats?: PlayerFormat[] };
  responseContext?: { visitorData?: string };
}

interface ClientSpec {
  credential: PlaybackCredential;
  client: string;
  headerName: string;
  version: string;
  userAgent: string;
  host: string;
  context?: Record<string, unknown>;
}

interface Bootstrap {
  visitorData: string | null;
  remixVersion: string | null;
  webVersion: string | null;
  fetchedAt: number;
}

let anonymousBootstrap: Bootstrap | null = null;
let sessionBootstrap: Bootstrap | null = null;

function isGooglevideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host !== "googlevideo.com" && !host.endsWith(".googlevideo.com")) return false;
    return url.pathname === "/videoplayback";
  } catch {
    return false;
  }
}

/** Picks the best playable audio format, preferring AAC for normal quality. */
function selectAudioFormat(formats: PlayerFormat[], quality: PlaybackQuality): PlayerFormat | null {
  const playable = formats.filter((format) => {
    if (typeof format.mimeType !== "string" || !format.mimeType.startsWith("audio/")) return false;
    if (format.drmFamilies || format.fairPlayKeyUri) return false;
    return typeof format.url === "string" && isGooglevideoUrl(format.url);
  });
  if (playable.length === 0) return null;

  if (quality === "high") {
    return playable.reduce((best, format) =>
      (format.bitrate ?? 0) > (best.bitrate ?? 0) ? format : best,
    );
  }

  const mp4 = playable.filter((format) => format.mimeType?.includes("audio/mp4"));
  const candidates = mp4.length > 0 ? mp4 : playable;
  const target = 128_000;
  return candidates.reduce((best, format) =>
    Math.abs((format.bitrate ?? 0) - target) < Math.abs((best.bitrate ?? 0) - target)
      ? format
      : best,
  );
}

/**
 * Visitor data + current client versions from the YouTube Music web bootstrap.
 *
 * The web client sends the same `visitorData` it bootstrapped with; without it
 * `WEB_REMIX` answers `UNPLAYABLE — Video unavailable` even for public tracks.
 * Cached briefly because it is only a page fetch and changes rarely.
 */
async function loadBootstrap(cookieHeader: string | null): Promise<Bootstrap> {
  const cached = cookieHeader ? sessionBootstrap : anonymousBootstrap;
  if (cached && Date.now() - cached.fetchedAt < BOOTSTRAP_TTL_MS) return cached;

  const result: Bootstrap = {
    visitorData: null,
    remixVersion: null,
    webVersion: null,
    fetchedAt: Date.now(),
  };
  try {
    const url = new URL("https://music.youtube.com/");
    const headers: Record<string, string> = {
      "user-agent": DESKTOP_UA,
      "accept-language": "en-US,en;q=0.9",
    };
    // The session's visitor id lives in VISITOR_INFO1_LIVE, so the bootstrap
    // must be authenticated: the player call and the attestation both have to
    // speak for the same visitor, or YouTube answers LOGIN_REQUIRED.
    if (cookieHeader) {
      Object.assign(headers, buildYouTubeCookieHeaders(cookieHeader, url));
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.ok) {
      const html = await response.text();
      result.visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ?? null;
      result.remixVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? null;
    }
  } catch (error) {
    logger.debug("youtube.playback bootstrap failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (cookieHeader) sessionBootstrap = result;
  else anonymousBootstrap = result;
  return result;
}

function clientsFor(credential: PlaybackCredential, bootstrap: Bootstrap): ClientSpec[] {
  const remix: ClientSpec = {
    credential,
    client: "WEB_REMIX",
    headerName: "67",
    version: bootstrap.remixVersion ?? "1.20250219.01.00",
    userAgent: DESKTOP_UA,
    host: "https://music.youtube.com",
  };
  const web: ClientSpec = {
    credential,
    client: "WEB",
    headerName: "1",
    version: bootstrap.webVersion ?? "2.20261023.01.00",
    userAgent: DESKTOP_UA,
    host: "https://www.youtube.com",
  };
  const tv: ClientSpec = {
    credential,
    client: "TVHTML5",
    headerName: "7",
    version: "7.20250422.18.00",
    userAgent: TV_UA,
    host: "https://www.youtube.com",
    context: { clientScreen: "EMBED" },
  };
  const androidVr: ClientSpec = {
    credential,
    client: "ANDROID_VR",
    headerName: "28",
    version: "1.65.10",
    userAgent: VR_UA,
    host: "https://www.youtube.com",
    context: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
    },
  };
  const ios: ClientSpec = {
    credential,
    client: "IOS",
    headerName: "5",
    version: "20.11.6",
    userAgent: IOS_UA,
    host: "https://www.youtube.com",
    context: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.1.22D72",
    },
  };

  if (credential === "cookies") return [remix, web];
  if (credential === "tv") return [tv];
  return [androidVr, ios];
}

interface RequestCredentials {
  cookieHeader: string | null;
  accessToken: string | null;
  visitorData: string | null;
  /** Browser-minted BotGuard token for the web clients. */
  poToken: string | null;
}

async function requestPlayer(
  spec: ClientSpec,
  videoId: string,
  credentials: RequestCredentials,
): Promise<{ status: number; payload: PlayerResponse | null; transportError?: string }> {
  const url = new URL(`${spec.host}/youtubei/v1/player?prettyPrint=false`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": spec.userAgent,
    "accept-language": "en-US,en;q=0.9",
    "x-youtube-client-name": spec.headerName,
    "x-youtube-client-version": spec.version,
  };

  if (credentials.cookieHeader) {
    Object.assign(headers, buildYouTubeCookieHeaders(credentials.cookieHeader, url));
  }

  const tvToken = spec.credential === "tv" && credentials.accessToken ? credentials.accessToken : null;
  if (tvToken) {
    headers.authorization = `Bearer ${tvToken}`;
    headers["x-goog-authuser"] = "0";
    headers["x-goog-request-time"] = String(Math.floor(Date.now() / 1000));
  }

  const visitorData = credentials.visitorData;
  if (visitorData) headers["x-goog-visitor-id"] = visitorData;

  // A web-minted token is only meaningful for the web clients; TV/mobile use
  // separate attestation programs and reject it.
  const webPoToken =
    credentials.poToken && (spec.client === "WEB_REMIX" || spec.client === "WEB")
      ? credentials.poToken
      : null;

  const body = {
    context: {
      client: {
        clientName: spec.client,
        clientVersion: spec.version,
        hl: "en",
        gl: "US",
        ...(visitorData ? { visitorData } : {}),
        ...(spec.context ?? {}),
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    ...(webPoToken ? { serviceIntegrityDimensions: { poToken: webPoToken } } : {}),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        status: response.status,
        payload: null,
        transportError: text.slice(0, 200) || `HTTP ${response.status}`,
      };
    }
    let payload: PlayerResponse | null = null;
    try {
      payload = JSON.parse(text) as PlayerResponse;
    } catch {
      return { status: response.status, payload: null, transportError: "unreadable body" };
    }
    return { status: response.status, payload };
  } catch (error) {
    return {
      status: 0,
      payload: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

function describeAttempt(
  spec: ClientSpec,
  payload: PlayerResponse,
): PlaybackAttempt {
  const adaptive = payload.streamingData?.adaptiveFormats ?? [];
  const muxed = payload.streamingData?.formats ?? [];
  const audio = [...adaptive, ...muxed].filter(
    (format) => typeof format.mimeType === "string" && format.mimeType.startsWith("audio/"),
  );
  return {
    credential: spec.credential,
    client: spec.client,
    playability: payload.playabilityStatus?.status ?? "UNKNOWN",
    reason: payload.playabilityStatus?.reason?.trim() || undefined,
    audioFormats: audio.length,
    playableFormats: audio.filter(
      (format) =>
        typeof format.url === "string"
        && !format.drmFamilies
        && !format.fairPlayKeyUri,
    ).length,
  };
}

/**
 * Resolves a playable audio URL for `videoId`, preferring the user's imported
 * YouTube session and degrading to OAuth/anonymous clients. Never returns
 * credentials — only the short-lived googlevideo URL for the media relay.
 */
export interface PlaybackOptions {
  /**
   * BotGuard token minted in the user's browser. The gated `WEB_REMIX`
   * player call needs one even with a signed-in cookie session; the browser
   * cannot send it directly (its /player calls go through this proxy, which
   * strips it), so it travels with this request instead.
   */
  poToken?: string | null;
}

export async function resolveYouTubePlayback(
  db: Db,
  config: ServerConfig,
  userId: string,
  videoId: string,
  quality: PlaybackQuality = "normal",
  options: PlaybackOptions = {},
): Promise<PlaybackResolution> {
  const cookieHeader = loadYouTubeCookies(db, config, userId);
  const accessToken = await getValidAccessToken(db, config, userId).catch(() => null);
  const bootstrap = await loadBootstrap(cookieHeader);
  const visitorData = bootstrap.visitorData;

  const attempts: PlaybackAttempt[] = [];
  const credentials: RequestCredentials = {
    cookieHeader,
    accessToken,
    visitorData,
    poToken: options.poToken && options.poToken.length <= 4096 ? options.poToken : null,
  };

  const credentialsToTry: PlaybackCredential[] = [];
  if (cookieHeader) credentialsToTry.push("cookies");
  if (accessToken) credentialsToTry.push("tv");
  credentialsToTry.push("anonymous");

  for (const credential of credentialsToTry) {
    for (const spec of clientsFor(credential, bootstrap)) {
      const { status, payload, transportError } = await requestPlayer(spec, videoId, credentials);
      if (!payload) {
        attempts.push({
          credential,
          client: spec.client,
          playability: status === 0 ? "TRANSPORT_ERROR" : `HTTP_${status}`,
          reason: transportError,
          audioFormats: 0,
          playableFormats: 0,
        });
        logger.warn("youtube.playback client failed", {
          userId,
          videoId,
          credential,
          client: spec.client,
          status,
          error: transportError ?? null,
        });
        continue;
      }

      const attempt = describeAttempt(spec, payload);
      attempts.push(attempt);
      const selected = selectAudioFormat(
        [...(payload.streamingData?.adaptiveFormats ?? []), ...(payload.streamingData?.formats ?? [])],
        quality,
      );
      if (selected?.url) {
        logger.info("youtube.playback resolved", {
          userId,
          videoId,
          credential,
          client: spec.client,
          itag: selected.itag ?? null,
          mimeType: selected.mimeType ?? null,
        });
        return {
          ok: true,
          playback: {
            url: selected.url,
            mimeType: selected.mimeType ?? "audio/mp4",
            itag: selected.itag ?? null,
            via: credential,
          },
        };
      }
      logger.debug("youtube.playback client gave no playback", {
        userId,
        videoId,
        credential,
        client: spec.client,
        attempt,
      });
    }
  }

  const playabilities = new Set(attempts.map((attempt) => attempt.playability));
  const anyLoginRequired = attempts.some((attempt) => attempt.playability === "LOGIN_REQUIRED");
  const anyPlayableFormats = attempts.some((attempt) => attempt.playableFormats > 0);

  let status = 502;
  let reason: string;
  if (!cookieHeader && anyLoginRequired) {
    status = 401;
    reason =
      "YouTube requires a signed-in session for this track. Use Settings → Playback sign-in to connect your YouTube account.";
  } else if (cookieHeader && anyLoginRequired) {
    status = 401;
    reason =
      "YouTube rejected the saved session. Re-import your YouTube cookies from a freshly signed-in browser tab.";
  } else if (attempts.every((attempt) => attempt.playability === "TRANSPORT_ERROR")) {
    status = 502;
    reason = "YouTube did not respond to the playback request.";
  } else if (attempts.some((attempt) => attempt.playableFormats > 0) && !anyPlayableFormats) {
    reason = "YouTube returned ciphered audio the server cannot decode.";
  } else if (attempts.length === 0) {
    status = 409;
    reason = "No YouTube credential is available for playback.";
  } else {
    reason = `YouTube could not play this track (${[...playabilities].join(", ")}).`;
  }

  logger.warn("youtube.playback unresolved", {
    userId,
    videoId,
    cookieLinked: Boolean(cookieHeader),
    oauthLinked: Boolean(accessToken),
    playabilities: [...playabilities],
    attempts,
  });

  return { ok: false, status, reason, attempts };
}

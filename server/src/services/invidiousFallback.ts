import { logger } from "../logger.js";

/**
 * Invidious mirror fallback.
 *
 * Some label tracks are signed such that googlevideo serves only about their
 * first megabyte to this server and answers 403 past it, no matter which token
 * is attached. An Invidious instance resolves and proxies the audio from its
 * own egress, so its URL is not bound to our IP or our missing attestation.
 *
 * Best-effort by design: public instances rate-limit and disappear, so each one
 * is time-boxed and the caller continues normally when none answers.
 */

const DEFAULT_INSTANCES = ["https://inv.nadeko.net", "https://invidious.nerdvpn.de"];
const REQUEST_TIMEOUT_MS = 4_000;

export function invidiousInstances(): string[] {
  const raw = process.env.INVIDIOUS_INSTANCES?.trim();
  const list = raw ? raw.split(",") : DEFAULT_INSTANCES;
  return list
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

/** True when the host belongs to a configured instance (relay allowlist). */
export function isInvidiousHost(hostname: string): boolean {
  return invidiousInstances().some((base) => {
    try {
      return new URL(base).hostname === hostname;
    } catch {
      return false;
    }
  });
}

export type MirrorPlayback = { url: string; mimeType: string };

export async function resolveViaInvidious(videoId: string): Promise<MirrorPlayback | null> {
  for (const base of invidiousInstances()) {
    try {
      const response = await fetch(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn("youtube.mirror rejected", { base, status: response.status });
        continue;
      }
      const payload = (await response.json()) as { adaptiveFormats?: Array<Record<string, unknown>> };
      const audio = (payload.adaptiveFormats ?? [])
        .filter((format) => String(format.type ?? "").startsWith("audio") && typeof format.url === "string")
        .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0];
      if (!audio?.url) {
        logger.warn("youtube.mirror format missing", { base });
        continue;
      }
      logger.info("youtube.mirror resolved", { base, videoId });
      return {
        url: String(audio.url),
        mimeType: String(audio.type ?? "audio/mp4").split(";")[0],
      };
    } catch (error) {
      logger.warn("youtube.mirror failed", {
        base,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/**
 * Builds a same-origin URL that streams a resolved YouTube audio URL through
 * the backend (`/api/media/stream`). Replaces the desktop app's local media
 * server (`fetch_audio_source`); the browser can fetch it without CORS and
 * with Range support for seeking during native playback.
 *
 * Optional track metadata rides along so the server can record play history
 * (including for plays made through the HTTP API with a bearer key).
 */
export interface MediaStreamMeta {
  videoId?: string;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  durationSec?: number;
}

export function buildMediaStreamUrl(streamUrl: string, meta?: MediaStreamMeta): string {
  const params = new URLSearchParams();
  params.set("url", streamUrl);
  if (meta?.videoId) params.set("videoId", meta.videoId);
  if (meta?.title) params.set("title", meta.title);
  if (meta?.artist) params.set("artist", meta.artist);
  if (meta?.album) params.set("album", meta.album);
  if (meta?.artwork) params.set("artwork", meta.artwork);
  if (typeof meta?.durationSec === "number" && meta.durationSec > 0) {
    params.set("durationSec", String(Math.round(meta.durationSec)));
  }
  return `/api/media/stream?${params.toString()}`;
}

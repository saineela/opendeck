/**
 * Builds a same-origin URL that streams a resolved YouTube audio URL through
 * the backend (`/api/media/stream`). Replaces the desktop app's local media
 * server (`fetch_audio_source`); the browser can fetch it without CORS and
 * with Range support for seeking during native playback.
 */
export function buildMediaStreamUrl(streamUrl: string): string {
  return `/api/media/stream?url=${encodeURIComponent(streamUrl)}`;
}

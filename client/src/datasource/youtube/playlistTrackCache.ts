import type { Track, TrackPage } from "../types";

/** Return cached tracks verbatim as a terminal page when YouTube is unavailable. */
export function createCachedPlaylistFallback(
  tracks: Track[] | null | undefined,
): TrackPage | null {
  if (!tracks?.length) return null;
  return { tracks, hasMore: false };
}

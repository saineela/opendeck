import type { Lyrics } from "../types";

export interface LyricsSource {
  id: string;
  label: string;
  timeoutMs: number;
  wave: 1 | 2;
  requiresDuration?: boolean;
}

export const LYRICS_SOURCES: LyricsSource[] = [
  {
    id: "lrclib-exact",
    label: "LRCLIB",
    timeoutMs: 2_500,
    wave: 1,
    requiresDuration: true,
  },
  {
    id: "betterlyrics",
    label: "BetterLyrics",
    timeoutMs: 3_500,
    wave: 1,
  },
  {
    id: "lrclib-search",
    label: "LRCLIB search",
    timeoutMs: 4_500,
    wave: 1,
    requiresDuration: true,
  },
  {
    id: "youtube-transcript",
    label: "YouTube transcript",
    timeoutMs: 6_000,
    wave: 2,
  },
  {
    id: "youtube-music",
    label: "YouTube Music",
    timeoutMs: 6_000,
    wave: 2,
  },
];

export function pickBestLyrics<T extends { source: LyricsSource; lyrics: Lyrics | null }>(
  candidates: T[],
): T | undefined {
  return [...candidates]
    .sort(
      (left, right) =>
        LYRICS_SOURCES.findIndex((source) => source.id === left.source.id)
        - LYRICS_SOURCES.findIndex((source) => source.id === right.source.id),
    )
    .find((candidate) => (candidate.lyrics?.lines.length ?? 0) > 0);
}

export function planLyricsWaves(): LyricsSource[][] {
  const first = LYRICS_SOURCES.filter((source) => source.wave === 1);
  const rest = LYRICS_SOURCES.filter((source) => source.wave === 2);
  return [first, rest];
}

export function unmetPrecondition(
  source: LyricsSource,
  track: { durationSec?: number },
): string | null {
  if (source.requiresDuration && !(track.durationSec && track.durationSec > 0)) {
    return "Needs a track duration to match on";
  }
  return null;
}

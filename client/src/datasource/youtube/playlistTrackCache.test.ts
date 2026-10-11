import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import { createCachedPlaylistFallback } from "./playlistTrackCache";

function makeTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `youtube-${index}`,
    source: "youtube",
    title: `Track ${index}`,
    artist: `Artist ${index}`,
    playlistItemId: `playlist-item-${index}`,
  }));
}

describe("createCachedPlaylistFallback", () => {
  it("returns the complete cached playlist in its original order", () => {
    const cached = makeTracks(45).reverse();
    const fallback = createCachedPlaylistFallback(cached);

    expect(fallback).not.toBeNull();
    expect(fallback?.tracks).toBe(cached);
    expect(fallback?.tracks.map((track) => track.id)).toEqual(cached.map((track) => track.id));
    expect(fallback?.tracks[0]).toEqual(cached[0]);
    expect(fallback?.hasMore).toBe(false);
  });

  it("does not offer a fallback for a missing or empty playlist cache", () => {
    expect(createCachedPlaylistFallback(null)).toBeNull();
    expect(createCachedPlaylistFallback(undefined)).toBeNull();
    expect(createCachedPlaylistFallback([])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { SearchController } from "./SearchController";
import { DataSource } from "../datasource/DataSource";
import type { SearchResults, Track } from "../datasource/types";

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    source: "youtube",
    title: `Title ${id}`,
    artist: "Artist",
    ...extra,
  };
}

function emptyResults(tracks: Track[] = []): SearchResults {
  return { artists: [], tracks, albums: [], playlists: [] };
}

/** Minimal concrete DataSource exposing only search/searchTracks hooks. */
class FakeSource extends DataSource {
  searchCalls: string[] = [];
  searchTracksCalls: string[] = [];

  constructor(
    private readonly searchImpl?: DataSource["search"],
    private readonly searchTracksImpl?: DataSource["searchTracks"],
  ) {
    super();
  }

  async getTrack(): Promise<Track> {
    throw new Error("not used");
  }

  async getStreamUrl(): Promise<string> {
    throw new Error("not used");
  }

  override search?: DataSource["search"] = async (query, onUpdate) => {
    this.searchCalls.push(query);
    return this.searchImpl!(query, onUpdate);
  };

  override searchTracks?: DataSource["searchTracks"] = async (query, onUpdate) => {
    this.searchTracksCalls.push(query);
    return this.searchTracksImpl!(query, onUpdate);
  };
}

/** A source that only implements searchTracks (no combined search). */
class TracksOnlySource extends DataSource {
  searchTracks?: DataSource["searchTracks"];
  searchTracksCalls: string[] = [];

  constructor(impl: NonNullable<DataSource["searchTracks"]>) {
    super();
    this.searchTracks = async (query, onUpdate) => {
      this.searchTracksCalls.push(query);
      return impl(query, onUpdate);
    };
  }

  async getTrack(): Promise<Track> {
    throw new Error("not used");
  }

  async getStreamUrl(): Promise<string> {
    throw new Error("not used");
  }
}

describe("SearchController.query handling", () => {
  it("returns empty results for blank queries without hitting the source", async () => {
    const source = new FakeSource(async () => emptyResults([track("ignored")]));
    const controller = new SearchController(source);
    expect(await controller.search("   ")).toEqual(emptyResults());
    expect(await controller.searchTracks("")).toEqual([]);
    expect(source.searchCalls).toHaveLength(0);
    expect(source.searchTracksCalls).toHaveLength(0);
  });

  it("trims the query before forwarding it", async () => {
    const source = new FakeSource(async () => emptyResults());
    const controller = new SearchController(source);
    await controller.search("  loose end  ");
    expect(source.searchCalls).toEqual(["loose end"]);
  });
});

describe("SearchController stream sorting", () => {
  it("sorts tracks by view count descending", async () => {
    const source = new FakeSource(async () =>
      emptyResults([
        track("low", { viewCount: 100 }),
        track("high", { viewCount: 1_000_000 }),
        track("mid", { viewCount: 5000 }),
      ]),
    );
    const controller = new SearchController(source);
    const results = await controller.search("query");
    expect(results.tracks.map((t) => t.id)).toEqual(["high", "mid", "low"]);
  });

  it("breaks ties alphabetically by title", async () => {
    const source = new FakeSource(async () =>
      emptyResults([
        track("z", { viewCount: 10, title: "Zebra" }),
        track("a", { viewCount: 10, title: "Alpha" }),
        track("m", { viewCount: 10, title: "Mango" }),
      ]),
    );
    const controller = new SearchController(source);
    const results = await controller.search("query");
    expect(results.tracks.map((t) => t.id)).toEqual(["a", "m", "z"]);
  });

  it("pushes tracks without a view count to the end", async () => {
    const source = new FakeSource(async () =>
      emptyResults([
        track("unknown"),
        track("known", { viewCount: 1 }),
        track("popular", { viewCount: 9999 }),
      ]),
    );
    const controller = new SearchController(source);
    const results = await controller.search("query");
    expect(results.tracks.map((t) => t.id)).toEqual(["popular", "known", "unknown"]);
  });

  it("sorts progressive onUpdate batches too", async () => {
    const batches: SearchResults[] = [];
    const source = new FakeSource(async (_query, onUpdate) => {
      onUpdate?.(emptyResults([track("b", { viewCount: 1 }), track("a", { viewCount: 2 })]));
      onUpdate?.(emptyResults([track("c", { viewCount: 50 })]));
      return emptyResults([track("b", { viewCount: 1 })]);
    });
    const controller = new SearchController(source);
    const results = await controller.search("query", (update) => batches.push(update));

    expect(batches).toHaveLength(2);
    expect(batches[0].tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(batches[1].tracks.map((t) => t.id)).toEqual(["c"]);
    // Final result is sorted regardless of what the source returned.
    expect(results.tracks.map((t) => t.id)).toEqual(["b"]);
  });

  it("leaves non-track result categories untouched", async () => {
    const source = new FakeSource(async () => ({
      artists: [{ id: "ar1", name: "Artist" }],
      tracks: [track("t1", { viewCount: 5 })],
      albums: [{ id: "al1", title: "Album", artist: "Artist" }],
      playlists: [{ id: "pl1", title: "Playlist", owner: "me" }],
    }));
    const controller = new SearchController(source);
    const results = await controller.search("query");
    expect(results.artists).toHaveLength(1);
    expect(results.albums).toHaveLength(1);
    expect(results.playlists).toHaveLength(1);
  });
});

describe("SearchController fallback and suggestions", () => {
  it("falls back to searchTracks when no combined search exists", async () => {
    const source = new TracksOnlySource(async () => [
      track("b", { viewCount: 1 }),
      track("a", { viewCount: 9 }),
    ]);
    const controller = new SearchController(source);
    const results = await controller.search("query");
    expect(results.tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(results.artists).toEqual([]);
    expect(results.albums).toEqual([]);
    expect(results.playlists).toEqual([]);
  });

  it("searchTracks sorts by stream count", async () => {
    const source = new TracksOnlySource(async () => [
      track("b", { viewCount: 1 }),
      track("a", { viewCount: 9 }),
    ]);
    const controller = new SearchController(source);
    const tracks = await controller.searchTracks("  query  ");
    expect(tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(source.searchTracksCalls).toEqual(["query"]);
  });

  it("returns no suggestions without a suggestion-capable source", async () => {
    const source = new TracksOnlySource(async () => []);
    const controller = new SearchController(source);
    expect(await controller.getSearchSuggestions("anything")).toEqual([]);
  });

  it("forwards suggestions from the source", async () => {
    const suggestions = ["daft punk", "daft punkAround the World"];
    const source = new TracksOnlySource(async () => []);
    (source as DataSource).getSearchSuggestions = async (query, onUpdate) => {
      expect(query).toBe("daft");
      onUpdate?.(suggestions);
      return suggestions;
    };
    const controller = new SearchController(source);
    const seen: string[][] = [];
    const result = await controller.getSearchSuggestions("  daft  ", (update) =>
      seen.push(update),
    );
    expect(result).toEqual(suggestions);
    expect(seen).toEqual([suggestions]);
  });
});

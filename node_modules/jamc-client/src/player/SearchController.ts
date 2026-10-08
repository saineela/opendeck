import type { DataSource } from "../datasource/DataSource";
import type { SearchResults, Track } from "../datasource/types";

function streamSortValue(track: Track): number {
  return track.viewCount ?? -1;
}

function sortTracksByStreams(tracks: Track[]): Track[] {
  return [...tracks].sort((first, second) => {
    const streamDifference = streamSortValue(second) - streamSortValue(first);
    if (streamDifference !== 0) return streamDifference;
    return first.title.localeCompare(second.title);
  });
}

function sortSearchResultsByStreams(results: SearchResults): SearchResults {
  return {
    ...results,
    tracks: sortTracksByStreams(results.tracks),
  };
}

export class SearchController {
  constructor(private readonly dataSource: DataSource) {}

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { artists: [], tracks: [], albums: [], playlists: [] };
    }
    if (this.dataSource.search) {
      const sortUpdate = onUpdate
        ? (results: SearchResults) => onUpdate(sortSearchResultsByStreams(results))
        : undefined;
      const results = await this.dataSource.search(normalizedQuery, sortUpdate);
      return sortSearchResultsByStreams(results);
    }
    const tracks = await this.searchTracks(normalizedQuery, (items) => {
      onUpdate?.({ artists: [], tracks: items, albums: [], playlists: [] });
    });
    return { artists: [], tracks, albums: [], playlists: [] };
  }

  async searchTracks(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !this.dataSource.searchTracks) return [];
    const sortUpdate = onUpdate
      ? (tracks: Track[]) => onUpdate(sortTracksByStreams(tracks))
      : undefined;
    const tracks = await this.dataSource.searchTracks(normalizedQuery, sortUpdate);
    return sortTracksByStreams(tracks);
  }

  async getSearchSuggestions(
    query: string,
    onUpdate?: (suggestions: string[]) => void,
  ): Promise<string[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !this.dataSource.getSearchSuggestions) return [];
    return this.dataSource.getSearchSuggestions(normalizedQuery, onUpdate);
  }
}

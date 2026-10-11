import type { Album, Artist, Playlist, SearchResults, Track } from "../../datasource/types";

export type TabView =
  | "home"
  | "album"
  | "artist"
  | "playlist"
  | "search"
  | "settings"
  | "history"
  | "recommendations";
export type NavigableTabView = Exclude<TabView, "settings" | "history" | "recommendations">;

export interface TabViewState {
  title?: string;
  view: NavigableTabView;
  album?: Album;
  artist?: Artist;
  playlist?: Playlist;
  searchQuery?: string;
  searchResults?: Track[];
  mixedSearchResults?: SearchResults;
  searchLoading?: boolean;
}

export interface TabNavigationHistory {
  back: TabViewState[];
  forward: TabViewState[];
}

export interface Tab {
  id: string;
  title?: string;
  view: TabView;
  album?: Album;
  artist?: Artist;
  playlist?: Playlist;
  searchQuery?: string;
  searchResults?: Track[];
  mixedSearchResults?: SearchResults;
  searchLoading?: boolean;
  isQueueOpen?: boolean;
  navigationHistory?: TabNavigationHistory;
}

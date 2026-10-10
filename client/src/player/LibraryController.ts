import type { DataSource } from "../datasource/DataSource";
import type {
  Album,
  Artist,
  ArtistPage,
  AuthPrompt,
  LibrarySnapshot,
  Playlist,
  TrackPage,
  Track,
} from "../datasource/types";
import { logInternalError, logInternalInfo } from "../internal/logging";
import { getAuthSnapshot, signOut as signOutAppAccount } from "../auth/authClient";
import {
  addTracksToAppPlaylist,
  appPlaylistToPlaylist,
  createAppPlaylist,
  deleteAppPlaylist,
  fetchAppPlaylistTracks,
  fetchLibrarySnapshot,
  isAppPlaylist,
  likeAppTrack,
  renameAppPlaylist,
  removeTrackFromAppPlaylist,
  reorderAppPlaylist,
  serverTrackToTrack,
  unlikeAppTrack,
} from "../auth/appLibrary";
import {
  addLocalTrackToPlaylist,
  getLocalPlaylistTrackPage,
  getLocalTracksForPlaylist,
  isLocalPlaylist,
  removeLocalTrackFromPlaylist,
} from "./localPlaylists";

export type LibraryStatus = "restoring" | "signed-out" | "authorizing" | "loading" | "ready" | "error";

export interface LibraryState {
  status: LibraryStatus;
  authPrompt: AuthPrompt | null;
  library: LibrarySnapshot | null;
  pendingLikeTrackIds: ReadonlySet<string>;
  error: string | null;
}

type Listener = () => void;
const LIBRARY_REFRESH_TIMEOUT_MS = 20_000;
const SIGN_IN_REFRESH_RETRY_DELAYS_MS = [0, 1_500, 5_000];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class LibraryController {
  private readonly listeners = new Set<Listener>();
  private initializationPromise: Promise<void> | null = null;
  private appLibraryPromise: Promise<void> | null = null;
  /** This account's server-side library (playlists + likes), if signed in. */
  private appLibrary: {
    playlists: Playlist[];
    likedSongs: Track[];
    tracks: Map<string, Track[]>;
  } | null = null;
  /** True once a YouTube Music library snapshot has been loaded this session. */
  private hasYouTubeLibrary = false;
  private state: LibraryState = {
    status: "restoring",
    authPrompt: null,
    library: null,
    pendingLikeTrackIds: new Set(),
    error: null,
  };

  constructor(private readonly dataSource: DataSource) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): LibraryState {
    return this.state;
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.restoreSession().then(() => this.loadAppLibrary());
    return this.initializationPromise;
  }

  /**
   * Pulls this account's library from the server and merges it into state.
   * Safe to call whenever the auth session changes; a signed-out caller
   * simply drops the app-owned data.
   */
  async loadAppLibrary(): Promise<void> {
    if (this.appLibraryPromise) return this.appLibraryPromise;
    this.appLibraryPromise = (async () => {
      try {
        if (!getAuthSnapshot().authenticated) {
          this.appLibrary = null;
          this.mergeAppLibrary();
          return;
        }
        const payload = await fetchLibrarySnapshot();
        this.appLibrary = {
          playlists: payload.playlists.map(appPlaylistToPlaylist),
          likedSongs: payload.likedSongs.map(serverTrackToTrack),
          tracks: new Map(
            payload.playlists.map((playlist) => [
              playlist.id,
              playlist.tracks.map(serverTrackToTrack),
            ]),
          ),
        };
        this.mergeAppLibrary();
        logInternalInfo("LibraryController.loadAppLibrary success", {
          playlistCount: payload.counts.playlists,
          likedSongCount: payload.counts.likedSongs,
        });
      } catch (error) {
        logInternalError("LibraryController.loadAppLibrary failed", error);
      } finally {
        this.appLibraryPromise = null;
      }
    })();
    return this.appLibraryPromise;
  }

  /**
   * Folds the server-side library into the current snapshot.
   *
   * With YouTube linked, the two libraries are unioned (app playlists first,
   * app likes first). Without it, an app-only snapshot is synthesised so a
   * signed-in user still has a working library on any device.
   */
  private mergeAppLibrary(): void {
    const app = this.appLibrary;
    const current = this.state.library;

    if (current) {
      const ytPlaylists = current.playlists.filter((playlist) => !isAppPlaylist(playlist));
      const ytLikes = current.likedSongs.filter(
        (track) => !(app?.likedSongs.some((liked) => liked.id === track.id) ?? false),
      );
      const playlists = [...(app?.playlists ?? []), ...ytPlaylists];
      const likedSongs = [...(app?.likedSongs ?? []), ...ytLikes];
      if (
        playlists.length === current.playlists.length &&
        likedSongs.length === current.likedSongs.length
      ) {
        return; // no visible change — don't churn subscribers
      }
      this.setState({
        library: { ...current, playlists, likedSongs },
        ...(this.state.status === "signed-out" ? { status: "ready" as const } : {}),
      });
      return;
    }

    if (!app) return;
    const auth = getAuthSnapshot();
    this.setState({
      status: "ready",
      authPrompt: null,
      error: null,
      library: {
        account: { name: auth.user?.name ?? "You" },
        albums: [],
        playlists: app.playlists,
        likedSongsPlaylist: {
          id: "liked-songs",
          title: "Liked songs",
          owner: "You",
          kind: "liked-songs",
          isEditable: false,
        },
        likedSongs: app.likedSongs,
        recentlyPlayed: [],
      },
    });
  }

  /** Creates one of this account's playlists on the server. */
  async createPlaylist(name: string): Promise<Playlist> {
    const playlist = appPlaylistToPlaylist(await createAppPlaylist(name));
    await this.loadAppLibrary();
    if (!this.appLibrary) this.appLibrary = { playlists: [playlist], likedSongs: [], tracks: new Map() };
    else this.appLibrary.tracks.set(playlist.id, []);
    this.mergeAppLibrary();
    return playlist;
  }

  async renamePlaylist(playlist: Playlist, name: string): Promise<void> {
    await renameAppPlaylist(playlist.id, name);
    await this.loadAppLibrary();
    this.mergeAppLibrary();
  }

  async deletePlaylist(playlist: Playlist): Promise<void> {
    await deleteAppPlaylist(playlist.id);
    this.appLibrary?.tracks.delete(playlist.id);
    await this.loadAppLibrary();
    this.mergeAppLibrary();
  }

  async recoverConnection(): Promise<void> {
    if (this.state.status === "authorizing") return;

    try {
      const restored = await this.dataSource.restoreSession?.();
      if (restored) {
        await this.refresh();
        return;
      }

      if (this.state.library) {
        await this.refresh();
      } else {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
      }
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  private async restoreSession(): Promise<void> {
    try {
      const cachedLibrary = await this.dataSource.getCachedLibrary?.();
      if (cachedLibrary) {
        this.setState({ library: cachedLibrary, error: null });
      }

      const restored = await this.dataSource.restoreSession?.();
      if (!restored) {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
        return;
      }
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  async signIn(): Promise<void> {
    if (!this.dataSource.signIn) return;
    logInternalInfo("LibraryController.signIn start");
    this.setState({ status: "authorizing", authPrompt: null, error: null });
    try {
      await this.dataSource.signIn((authPrompt) => {
        logInternalInfo("LibraryController.signIn prompt received", {
          verificationUrl: authPrompt.verificationUrl,
          expiresInSec: authPrompt.expiresInSec,
        });
        this.setState({ status: "authorizing", authPrompt, error: null });
      });
      logInternalInfo("LibraryController.signIn authentication complete");
      await this.refreshAfterSignIn();
      logInternalInfo("LibraryController.signIn refresh complete");
    } catch (error) {
      this.setFailure("YouTube Music sign-in failed.", error);
    }
  }

  async signOut(): Promise<void> {
    try {
      // End the OpenDeck session too — the account, not just YouTube,
      // owns this browser's library view.
      if (getAuthSnapshot().authenticated) {
        try {
          await signOutAppAccount();
        } catch (error) {
          logInternalError("LibraryController.signOut server session failed", error);
        }
      }
      await this.dataSource.signOut?.();
      this.appLibrary = null;
      this.hasYouTubeLibrary = false;
      this.setState({
        status: "signed-out",
        authPrompt: null,
        library: null,
        pendingLikeTrackIds: new Set(),
        error: null,
      });
    } catch (error) {
      this.setFailure("Unable to sign out.", error);
    }
  }

  async refresh(options: { suppressFailure?: boolean } = {}): Promise<void> {
    if (!this.dataSource.getLibrary) return;
    this.setState({ status: "loading", authPrompt: null, error: null });
    try {
      const library = await withTimeout(
        this.dataSource.getLibrary((updatedLibrary) => {
          this.setState({ status: "ready", library: updatedLibrary, authPrompt: null, error: null });
        }),
        LIBRARY_REFRESH_TIMEOUT_MS,
        "YouTube Music library sync timed out.",
      );
      this.applyLibrary(library);
    } catch (error) {
      if (options.suppressFailure) throw error;
      this.setFailure("Unable to load your YouTube Music library.", error);
    }
  }

  private applyLibrary(library: LibrarySnapshot): void {
    this.hasYouTubeLibrary = true;
    // Re-merge the account's own playlists/likes so both libraries are visible.
    const app = this.appLibrary;
    const merged: LibrarySnapshot = app
      ? {
          ...library,
          playlists: [
            ...app.playlists,
            ...library.playlists.filter((playlist) => !isAppPlaylist(playlist)),
          ],
          likedSongs: [
            ...app.likedSongs,
            ...library.likedSongs.filter(
              (track) => !app.likedSongs.some((liked) => liked.id === track.id),
            ),
          ],
        }
      : library;
    this.setState({ status: "ready", library: merged, authPrompt: null, error: null });
    logInternalInfo("LibraryController.refresh success", {
      albumCount: merged.albums.length,
      playlistCount: merged.playlists.length,
      likedSongCount: merged.likedSongs.length,
      recentTrackCount: merged.recentlyPlayed.length,
    });
  }

  private hasCompleteEnoughLibrary(library: LibrarySnapshot | null): boolean {
    if (!library) return false;
    return library.playlists.length > 0
      || library.albums.length > 0
      || library.likedSongs.length > 0;
  }

  private async refreshAfterSignIn(): Promise<void> {
    let lastError: unknown = null;

    for (let index = 0; index < SIGN_IN_REFRESH_RETRY_DELAYS_MS.length; index += 1) {
      const delayMs = SIGN_IN_REFRESH_RETRY_DELAYS_MS[index];
      if (delayMs > 0) await delay(delayMs);

      try {
        await this.refresh({ suppressFailure: true });
        if (this.hasCompleteEnoughLibrary(this.state.library)) return;

        logInternalInfo("LibraryController.signIn retrying incomplete library", {
          attempt: index + 1,
          playlistCount: this.state.library?.playlists.length ?? 0,
          albumCount: this.state.library?.albums.length ?? 0,
          likedSongCount: this.state.library?.likedSongs.length ?? 0,
          recentTrackCount: this.state.library?.recentlyPlayed.length ?? 0,
        });
      } catch (error) {
        lastError = error;
        logInternalInfo("LibraryController.signIn library retry failed", {
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.state.library) return;
    throw lastError ?? new Error("YouTube Music library did not finish syncing after sign-in.");
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (!this.dataSource.getAlbumTracks) return [];
    return this.dataSource.getAlbumTracks(album, onUpdate);
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    if (!this.dataSource.getArtist) {
      throw new Error("Artist pages are unavailable.");
    }
    return this.dataSource.getArtist(artistId, onUpdate);
  }

  async setArtistSubscribed(artist: Artist, subscribed: boolean): Promise<void> {
    if (!this.dataSource.setArtistSubscribed) {
      throw new Error("Subscribing to artists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    if (!artist.id.startsWith("UC")) {
      throw new Error("This artist does not have a subscribable channel.");
    }
    return this.dataSource.setArtistSubscribed(artist.id, subscribed);
  }

  isAlbumSaved(albumId: string): boolean {
    return this.state.library?.albums.some((album) =>
      album.id === albumId || album.playlistId === albumId
    ) ?? false;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.dataSource.setAlbumSaved) {
      throw new Error("Saving albums is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const sameAlbum = (item: Album) =>
      item.id === album.id
      || Boolean(album.playlistId && item.playlistId === album.playlistId)
      || Boolean(album.playlistId && item.id === album.playlistId)
      || Boolean(item.playlistId && item.playlistId === album.id);
    const albums = saved
      ? [album, ...previousLibrary.albums.filter((item) => !sameAlbum(item))]
      : previousLibrary.albums.filter((item) => !sameAlbum(item));
    this.setState({ library: { ...previousLibrary, albums } });

    try {
      await this.dataSource.setAlbumSaved(album, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (isAppPlaylist(playlist)) {
      const tracks = await this.ensureAppPlaylistTracks(playlist.id);
      if (tracks.length > 0) onUpdate?.(tracks);
      return tracks;
    }
    if (playlist.kind === "liked-songs" && !this.hasYouTubeLibrary) {
      // No linked YouTube account: serve this account's own likes.
      const liked = this.state.library?.likedSongs ?? [];
      if (liked.length > 0) onUpdate?.(liked);
      return liked;
    }
    if (isLocalPlaylist(playlist)) {
      const page = await getLocalPlaylistTrackPage(playlist);
      if (page.tracks.length > 0) onUpdate?.(page.tracks);
      return page.tracks;
    }

    const localTracks = getLocalTracksForPlaylist(playlist);
    const mergeLocalTracks = (tracks: Track[]): Track[] => [...tracks, ...localTracks];
    if (!this.dataSource.getPlaylistTracks) return localTracks;
    const tracks = await this.dataSource.getPlaylistTracks(
      playlist,
      (updatedTracks) => onUpdate?.(mergeLocalTracks(updatedTracks)),
    );
    return mergeLocalTracks(tracks);
  }

  async getPlaylistTrackPage(
    playlist: Playlist,
    pageKey?: string,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage> {
    if (isAppPlaylist(playlist)) {
      const page: TrackPage = {
        tracks: pageKey ? [] : await this.ensureAppPlaylistTracks(playlist.id),
        hasMore: false,
      };
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }
    if (playlist.kind === "liked-songs" && !this.hasYouTubeLibrary) {
      const liked = pageKey ? [] : this.state.library?.likedSongs ?? [];
      const page: TrackPage = { tracks: liked, hasMore: false };
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }
    if (isLocalPlaylist(playlist)) {
      const page = pageKey ? { tracks: [], hasMore: false } : await getLocalPlaylistTrackPage(playlist);
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }

    const localTracks = pageKey ? [] : getLocalTracksForPlaylist(playlist);
    const mergeLocalTracks = (page: TrackPage): TrackPage => ({
      ...page,
      tracks: [...page.tracks, ...localTracks],
    });

    if (!this.dataSource.getPlaylistTrackPage) {
      const tracks = pageKey
        ? []
        : await this.dataSource.getPlaylistTracks?.(playlist) ?? [];
      const page = mergeLocalTracks({ tracks, hasMore: false });
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }
    const page = await this.dataSource.getPlaylistTrackPage(playlist, pageKey, (updatedPage) => {
      onUpdate?.(pageKey ? updatedPage : mergeLocalTracks(updatedPage));
    });
    return pageKey ? page : mergeLocalTracks(page);
  }

  async getRecommendations(seed: Track): Promise<Track[]> {
    return this.dataSource.getRecommendations?.(seed) ?? [];
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (isAppPlaylist(playlist)) {
      const existing = this.appLibrary?.tracks.get(playlist.id);
      if (existing?.some((item) => item.id === track.id)) return "already-present";
      await addTracksToAppPlaylist(playlist.id, [track]);
      if (existing) existing.push(track);
      else this.appLibrary?.tracks.set(playlist.id, [track]);
      await this.loadAppLibrary();
      this.mergeAppLibrary();
      return "added";
    }
    if (track.source === "local") {
      if (isLocalPlaylist(playlist)) {
        throw new Error("Local songs are already managed from Local Files.");
      }
      return addLocalTrackToPlaylist(track, playlist);
    }
    if (!this.dataSource.addTrackToPlaylist) {
      throw new Error("Adding songs to playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in before adding songs to playlists.");
    }
    return this.dataSource.addTrackToPlaylist(track, playlist);
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    if (isAppPlaylist(playlist)) {
      await removeTrackFromAppPlaylist(playlist.id, track.id);
      const existing = this.appLibrary?.tracks.get(playlist.id);
      if (existing) this.appLibrary?.tracks.set(playlist.id, existing.filter((item) => item.id !== track.id));
      await this.loadAppLibrary();
      this.mergeAppLibrary();
      return;
    }
    if (track.source === "local" && !isLocalPlaylist(playlist)) {
      removeLocalTrackFromPlaylist(track, playlist);
      return;
    }
    if (!this.dataSource.removeTrackFromPlaylist) {
      logInternalError("LibraryController.removeTrackFromPlaylist unavailable", {
        dataSource: this.dataSource.constructor.name,
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("Removing songs from playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    return this.dataSource.removeTrackFromPlaylist(track, playlist);
  }

  isPlaylistSaved(playlistId: string): boolean {
    const normalizedId = playlistId.replace(/^VL/, "");
    return this.state.library?.playlists.some(
      (playlist) => playlist.id.replace(/^VL/, "") === normalizedId,
    ) ?? false;
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.dataSource.setPlaylistSaved) {
      throw new Error("Saving playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const normalizedId = playlist.id.replace(/^VL/, "");
    const playlists = saved
      ? [
          { ...playlist, isSaved: true, isEditable: playlist.isEditable ?? false },
          ...previousLibrary.playlists.filter(
            (item) => item.id.replace(/^VL/, "") !== normalizedId,
          ),
        ]
      : previousLibrary.playlists.filter(
          (item) => item.id.replace(/^VL/, "") !== normalizedId,
        );
    this.setState({ library: { ...previousLibrary, playlists } });

    try {
      await this.dataSource.setPlaylistSaved(playlist, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  isTrackLiked(trackId: string): boolean {
    return this.state.library?.likedSongs.some((track) => track.id === trackId) ?? false;
  }

  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    const auth = getAuthSnapshot();
    const useAppLibrary = auth.authenticated;
    const useYouTube = Boolean(this.dataSource.setTrackLiked) && this.hasYouTubeLibrary;
    if (!useAppLibrary && !useYouTube) {
      throw new Error("Sign in to like");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to like");
    }
    if (this.state.pendingLikeTrackIds.has(track.id)) return;

    const previousLibrary = this.state.library;
    const pendingLikeTrackIds = new Set(this.state.pendingLikeTrackIds);
    pendingLikeTrackIds.add(track.id);
    const likedSongs = liked
      ? [track, ...previousLibrary.likedSongs.filter((item) => item.id !== track.id)]
      : previousLibrary.likedSongs.filter((item) => item.id !== track.id);

    this.setState({
      library: { ...previousLibrary, likedSongs },
      pendingLikeTrackIds,
    });

    try {
      if (useAppLibrary) {
        // The account's own list on the server is authoritative; a failure
        // here rolls the optimistic update back rather than silently drifting.
        if (liked) await likeAppTrack(track);
        else await unlikeAppTrack(track.id);
        if (this.appLibrary) {
          this.appLibrary = {
            ...this.appLibrary,
            likedSongs: liked
              ? [track, ...this.appLibrary.likedSongs.filter((item) => item.id !== track.id)]
              : this.appLibrary.likedSongs.filter((item) => item.id !== track.id),
          };
        }
      }
      if (useYouTube && auth.youtubeLinked && this.dataSource.setTrackLiked) {
        // Mirror to YouTube Music when it is linked. Best effort: the like is
        // already saved to this account, so a YouTube hiccup must not undo it.
        try {
          await this.dataSource.setTrackLiked(track, liked);
        } catch (error) {
          logInternalError("LibraryController.setTrackLiked YouTube mirror failed", error);
        }
      }
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    } finally {
      const nextPending = new Set(this.state.pendingLikeTrackIds);
      nextPending.delete(track.id);
      this.setState({ pendingLikeTrackIds: nextPending });
    }
  }

  /** Loads (and caches) an account-owned playlist's tracks from the server. */
  private async ensureAppPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.appLibrary) return [];
    const cached = this.appLibrary.tracks.get(playlistId);
    if (cached) return cached;
    try {
      const tracks = await fetchAppPlaylistTracks(playlistId);
      this.appLibrary.tracks.set(playlistId, tracks);
      return tracks;
    } catch (error) {
      logInternalError("LibraryController.ensureAppPlaylistTracks failed", error);
      return [];
    }
  }

  async reorderAppPlaylistTracks(playlist: Playlist, trackIds: string[]): Promise<void> {
    await reorderAppPlaylist(playlist.id, trackIds);
    const tracks = await fetchAppPlaylistTracks(playlist.id);
    this.appLibrary?.tracks.set(playlist.id, tracks);
  }

  private setFailure(message: string, error: unknown) {
    logInternalError("LibraryController operation failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    this.setState({
      status: "error",
      error: detail && detail !== "[object Object]" ? `${message}\n\n${detail}` : message,
      authPrompt: null,
    });
  }

  private setState(partial: Partial<LibraryState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

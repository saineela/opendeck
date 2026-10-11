import { ClientType, Constants, Innertube, Platform, Types, YTNodes } from "youtubei.js";
import { clearCache, getCachedJson, setCachedJson } from "../../internal/cache";
import {
  cancelYouTubeLink,
  fetchYouTubeLibrary,
  getYouTubeLinkStatus,
  refreshYouTubeLinkedFlag,
  signOut as signOutGoogle,
  startYouTubeLink,
  refreshAuthSession,  unlinkYouTube,

} from "../../auth/authClient";
import { readLocalAudio } from "../../player/localFiles";
import { buildMediaStreamUrl } from "../../platform/mediaStream";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { DataSource, type StreamData } from "../DataSource";
import type {
  Album,
  Artist,
  ArtistPage,
  ArtistReference,
  AuthPrompt,
  LibrarySnapshot,
  Lyrics,
  Playlist,
  SearchResults,
  TrackPage,
  Track,
} from "../types";
import { collectArtworkCandidates, getVideoArtworkFallback, selectArtworkUrl } from "./artwork";
import { mintPoToken } from "./poToken";
import { createCachedPlaylistFallback } from "./playlistTrackCache";
import { tauriFetch } from "./tauriFetch";
import {
  getStreamingQuality,
  selectFormatForQuality,
  type AudioQuality,
} from "../../internal/audioQuality";
import {
  usesAuthenticatedStreaming,
  usesYouTubeScrobbling,
} from "../../ui/settings/youtubeAccount";

type ClientLabel = "music" | "web" | "anonymous" | "download" | "android" | "ios";

type MusicColumn = {
  title?: {
    toString(): string;
    runs?: Array<{
      text?: string;
      endpoint?: unknown;
      navigationEndpoint?: unknown;
    }>;
  };
};


type MusicItem = {
  id?: string;
  title?: string | { toString(): string };
  item_type?: string;
  menu?: unknown;
  artists?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  authors?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  author?: { name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } };
  subtitle?: {
    toString(): string;
    runs?: Array<{ text?: string; endpoint?: { payload?: { browseId?: string } } }>;
  };
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>
    | { contents?: Array<{ url?: string; width?: number; height?: number }> }
    | null;
  thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
  endpoint?: {
    payload?: {
      browseId?: string;
      videoId?: string;
    };
  };
  on_tap?: unknown;
  views?: string;
  subscribers?: string;
  year?: string;
  header?: {
    title?: { toString(): string };
  };
  subtitle_badges?: Array<{ label?: string }>;
  end_icon_type?: string;
  fixed_columns?: MusicColumn[];
  flex_columns?: MusicColumn[];
};

type ParsedMusicResponse = {
  contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
  continuation_contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
};

type MusicContinuation = {
  key: string;
  load(): Promise<unknown>;
};

type YouTubeMusicPlaylistPage = {
  items?: MusicItem[];
  contents?: MusicItem[];
  has_continuation?: boolean;
  getContinuation(): Promise<YouTubeMusicPlaylistPage>;
};

type PlaylistPageSession = {
  playlistId: string;
  playlistPage: YouTubeMusicPlaylistPage;
  seenTrackIds: Set<string>;
  expiresAt: number;
};

type UpNextItem = {
  video_id?: string;
  title?: { toString(): string };
  author?: string;
  artists?: Array<{ name?: string; channel_id?: string; endpoint?: unknown; navigationEndpoint?: unknown }>;
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
  duration?: { seconds?: number };
  primary?: UpNextItem | null;
};

type LrcLibTrack = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
};

type BetterLyricsResponse = {
  ttml?: string | null;
};

type LyricsProviderResult = Lyrics & {
  priority: number;
};

type RawLikeEndpoint = {
  status?: string;
  target?: string | {
    playlistId?: string;
    videoId?: string;
  };
  params?: string;
  likeParams?: string;
  removeLikeParams?: string;
};

type CallableEndpoint = {
  call(actions: Innertube["actions"], args?: Record<string, unknown>): Promise<{
    success?: boolean;
    status_code?: number;
  }>;
  payload?: unknown;
};

type AttestationCommand = {
  engagementType?: string;
  ids?: Array<Record<string, unknown>>;
};

type LibraryToggleEndpoint = {
  isToggled?: boolean;
  endpoint?: CallableEndpoint;
  toggledEndpoint?: CallableEndpoint;
  iconType?: string;
  tooltip?: string;
  toggledTooltip?: string;
};

type RawServiceEndpoint = {
  commandExecutorCommand?: {
    commands?: RawServiceEndpoint[];
  };
  feedbackEndpoint?: {
    feedbackToken?: string;
    cpn?: string;
    isFeedbackTokenUnencrypted?: boolean;
    shouldMerge?: boolean;
  };
  likeEndpoint?: RawLikeEndpoint;
};

type RawToggleButtonRenderer = {
  isToggled?: boolean;
  defaultIcon?: { iconType?: string };
  defaultTooltip?: string;
  toggledTooltip?: string;
  defaultServiceEndpoint?: RawServiceEndpoint;
  toggledServiceEndpoint?: RawServiceEndpoint;
};

type RawToggleMenuServiceItemRenderer = {
  isToggled?: boolean;
  defaultIcon?: { iconType?: string };
  toggledIcon?: { iconType?: string };
  defaultText?: unknown;
  toggledText?: unknown;
  defaultServiceEndpoint?: RawServiceEndpoint;
  toggledServiceEndpoint?: RawServiceEndpoint;
};

type AccountCandidate = {
  accountIndex: number;
  name?: string;
  artworkUrl?: string;
  onBehalfOfUser?: string;
  serializedDelegationContext?: string;
  selected?: boolean;
};

function accountCandidateKey(candidate: {
  accountIndex: number;
  onBehalfOfUser?: string | null;
  serializedDelegationContext?: string | null;
}): string {
  return [
    candidate.accountIndex,
    candidate.onBehalfOfUser ?? "",
    candidate.serializedDelegationContext ?? "",
  ].join(":");
}

type LibraryResponses = {
  client: Innertube;
  account: AccountCandidate;
  libraryLanding: unknown;
  historyResponse: unknown;
};

function createPlaybackNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte & 63]).join("");
}

function summarizePlaybackStatsUrl(baseUrl: string): Record<string, unknown> {
  try {
    const url = new URL(baseUrl);
    const safeKeys = [
      "docid",
      "ns",
      "el",
      "len",
      "c",
      "cver",
      "fmt",
      "feature",
      "referrer",
      "uga",
      "plid",
    ];
    const params: Record<string, string> = {};
    for (const key of safeKeys) {
      const value = url.searchParams.get(key);
      if (value) params[key] = value;
    }
    return {
      endpoint: url.pathname,
      paramCount: [...url.searchParams.keys()].length,
      params,
      hasOf: url.searchParams.has("of"),
      hasVm: url.searchParams.has("vm"),
      hasCpn: url.searchParams.has("cpn"),
    };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

const LIKED_SONGS_PLAYLIST_ID = "LM";
const LIBRARY_CACHE_KEY = "youtube-music:library:v5";
const ARTIST_CACHE_VERSION = "v3";
const ARTIST_SUBSCRIPTION_OVERRIDE_MS = 60_000;
const PLAYLIST_PAGE_SESSION_TTL_MS = 10 * 60_000;
const PLAYLIST_TRACK_CACHE_VERSION = "v4";
const PLAYLIST_EMPTY_RETRY_DELAYS_MS = [0, 600, 1_500];
const SELECTED_ACCOUNT_STORAGE_KEY = "youtube-music:selected-account";

class YouTubeMusicAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeMusicAuthError";
  }
}

export class YouTubeMusicDataSource extends DataSource {
  private musicClientPromise: Promise<Innertube> | null = null;
  private webClientPromise: Promise<Innertube> | null = null;
  private anonymousClientPromise: Promise<Innertube> | null = null;
  private downloadClientPromise: Promise<Innertube> | null = null;
  private androidClientPromise: Promise<Innertube> | null = null;
  private iosClientPromise: Promise<Innertube> | null = null;
  private musicAccountIndex = 0;
  private musicOnBehalfOfUser: string | null = null;
  private musicSerializedDelegationContext: string | null = null;
  private musicAccountName = "YouTube Music";
  private musicAccountArtworkUrl: string | null = null;
  private playReport: {
    trackId: string;
    cpn: string;
    playbackUrl: string;
    watchtimeUrl: string;
    startedAt: number;
    lastReportedSec: number;
  } | null = null;
  private libraryRefreshPromise: Promise<LibrarySnapshot> | null = null;
  private readonly albumRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly playlistRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly playlistPageSessions = new Map<string, PlaylistPageSession>();
  private readonly trackRefreshPromises = new Map<string, Promise<Track>>();
  private readonly searchRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly mixedSearchRefreshPromises = new Map<string, Promise<SearchResults>>();
  private readonly artistRefreshPromises = new Map<string, Promise<ArtistPage>>();
  private readonly suggestionRefreshPromises = new Map<string, Promise<string[]>>();
  private readonly recommendationRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly lyricsRefreshPromises = new Map<string, Promise<Lyrics | null>>();
  private readonly artistSubscriptionOverrides = new Map<string, { subscribed: boolean; expiresAt: number }>();

  constructor() {
    super();
    this.setupJavaScriptEvaluator();
  }

  /**
   * True while a YouTube Music account is linked for this session. The
   * desktop app used a YouTube cookie here; on the web the equivalent
   * credentials live server-side and are injected into proxied requests.
   */
  private signedIn = false;

  private setupJavaScriptEvaluator() {
    Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
      logInternalDebug("YouTubeMusicDataSource.javascriptEvaluator", {
        envKeys: Object.keys(env),
        outputLength: data.output?.length ?? 0,
      });

      return new Function(data.output)();
    };
  }

  private getSessionOptions(retrievePlayer = true) {
    return {
      fetch: tauriFetch,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      account_index: this.musicAccountIndex,
      on_behalf_of_user: this.musicOnBehalfOfUser ?? undefined,
      retrieve_player: retrievePlayer,
      generate_session_locally: true,
    } as const;
  }

  private getAnonymousSessionOptions(retrievePlayer = true) {
    return {
      fetch: tauriFetch,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      retrieve_player: retrievePlayer,
      generate_session_locally: true,
    } as const;
  }

  private async createMusicClient(retrievePlayer = true): Promise<Innertube> {
    const client = await Innertube.create({
      ...this.getSessionOptions(retrievePlayer),
      client_type: ClientType.MUSIC,
    });
    await this.refreshMusicClientMetadata(client);
    this.applyDelegationContext(client);
    return client;
  }

  private getMusicClient(): Promise<Innertube> {
    if (!this.musicClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getMusicClient creating client");
      this.musicClientPromise = this.createMusicClient(true);
    }

    return this.musicClientPromise;
  }

  private getWebClient(): Promise<Innertube> {
    if (!this.webClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getWebClient creating client");
      this.webClientPromise = Innertube.create({
        ...this.getSessionOptions(),
        client_type: ClientType.WEB,
      });
    }

    return this.webClientPromise;
  }

  private getAnonymousClient(): Promise<Innertube> {
    if (!this.anonymousClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getAnonymousClient creating client");
      this.anonymousClientPromise = Innertube.create({
        ...this.getAnonymousSessionOptions(),
        client_type: ClientType.WEB,
      });
    }

    return this.anonymousClientPromise;
  }

  /**
   * The WEB-family clients (WEB, WEB_REMIX, MWEB) stopped returning playable
   * streaming data without a valid, video-bound po-token — and YouTube now
   * answers UNPLAYABLE "Video unavailable" when attestation is missing
   * entirely. The ANDROID/IOS app clients are kept as fallbacks: they often
   * still serve plain URLs when the web clients are refused. They skip player
   * retrieval (their URLs are not ciphered) so a fallback costs no extra
   * player download.
   */
  private createMobileClient(type: "android" | "ios"): Promise<Innertube> {
    const constants = type === "android" ? Constants.CLIENTS.ANDROID : Constants.CLIENTS.IOS;
    return Innertube.create({
      fetch: tauriFetch,
      user_agent: constants.USER_AGENT,
      client_type: type === "android" ? ClientType.ANDROID : ClientType.IOS,
      retrieve_player: false,
      generate_session_locally: true,
      enable_session_cache: false,
    });
  }

  private getAndroidClient(): Promise<Innertube> {
    if (!this.androidClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getAndroidClient creating client");
      this.androidClientPromise = this.createMobileClient("android").catch((error) => {
        this.androidClientPromise = null;
        throw error;
      });
    }

    return this.androidClientPromise;
  }

  private getIosClient(): Promise<Innertube> {
    if (!this.iosClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getIosClient creating client");
      this.iosClientPromise = this.createMobileClient("ios").catch((error) => {
        this.iosClientPromise = null;
        throw error;
      });
    }

    return this.iosClientPromise;
  }

  private getDownloadClient(): Promise<Innertube> {
    if (!this.downloadClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getDownloadClient creating client");
      this.downloadClientPromise = (async () => {
        const bootstrap = await Innertube.create({
          fetch: tauriFetch,
          retrieve_player: false,
          generate_session_locally: false,
        });

        return Innertube.create({
          fetch: tauriFetch,
          retrieve_player: true,
          generate_session_locally: false,
          visitor_data: bootstrap.session.context.client.visitorData,
          client_type: ClientType.MUSIC,
        });
      })();
    }

    return this.downloadClientPromise;
  }

  private async getClient(label: ClientLabel): Promise<Innertube> {
    if (label === "download") return this.getDownloadClient();
    if (label === "anonymous") return this.getAnonymousClient();
    if (label === "android") return this.getAndroidClient();
    if (label === "ios") return this.getIosClient();
    return label === "music" ? this.getMusicClient() : this.getWebClient();
  }

  private withSessionClientVersion(streamUrl: string, client: Innertube): string {
    const sessionVersion = client.session.context.client.clientVersion;
    if (!sessionVersion) return streamUrl;

    return streamUrl.replace(
      /([?&]cver=)[^&]*/,
      `$1${encodeURIComponent(sessionVersion)}`,
    );
  }

  private async refreshMusicClientMetadata(client: Innertube): Promise<void> {
    try {
      const response = await tauriFetch("https://music.youtube.com/", {
        headers: {
          Accept: "text/html",
        },
      });
      if (!response.ok) {
        throw new Error(`YouTube Music bootstrap returned HTTP ${response.status}.`);
      }

      const html = await response.text();
      const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

      if (!clientVersion) {
        throw new Error("YouTube Music bootstrap did not contain a client version.");
      }

      client.session.context.client.clientVersion = clientVersion;
      client.session.context.client.originalUrl = "https://music.youtube.com";
      if (client.session.context.client.mainAppWebInfo) {
        client.session.context.client.mainAppWebInfo.graftUrl = "https://music.youtube.com";
      }
      delete client.session.context.client.configInfo;
      if (apiKey) client.session.api_key = apiKey;

      logInternalInfo("YouTubeMusicDataSource.refreshMusicClientMetadata success", {
        clientVersion,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.refreshMusicClientMetadata failed", {
        error: error instanceof Error ? error.message : String(error),
        fallbackVersion: client.session.context.client.clientVersion,
      });
    }
  }

  private applyDelegationContext(client: Innertube): void {
    if (!this.musicSerializedDelegationContext) return;
    const session = client.session as {
      context: {
        user: {
          serializedDelegationContext?: string;
        };
      };
    };
    session.context.user.serializedDelegationContext = this.musicSerializedDelegationContext;
  }

  private resetMusicSessionSelection(): void {
    try {
      localStorage.removeItem(SELECTED_ACCOUNT_STORAGE_KEY);
    } catch {
      // A stale preference is ignored anyway if it cannot be read or does not match.
    }
    this.musicAccountIndex = 0;
    this.musicOnBehalfOfUser = null;
    this.musicSerializedDelegationContext = null;
    this.musicAccountName = "YouTube Music";
    this.musicAccountArtworkUrl = null;
    this.musicClientPromise = null;
    this.webClientPromise = null;
  }

  private getArtwork(item: MusicItem): string | undefined {
    return selectArtworkUrl(collectArtworkCandidates(item.thumbnail, item.thumbnails));
  }

  private normalizeSearchKey(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  private getArtistName(item: MusicItem): string {
    return item.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
      || item.authors?.map((author) => author.name).filter(Boolean).join(", ")
      || item.author?.name
      || item.subtitle?.runs
        ?.filter((run) => run.endpoint?.payload?.browseId?.startsWith("UC"))
        .map((run) => run.text)
        .filter(Boolean)
        .join(", ")
      || item.subtitle?.toString()
      || "Unknown artist";
  }

  private getArtists(item: MusicItem): ArtistReference[] | undefined {
    const toArtistReference = (value: unknown) => {
      const candidate = value as {
        name?: string;
        text?: string;
        channel_id?: string;
        endpoint?: unknown;
        navigationEndpoint?: unknown;
      };
      return {
        id: candidate.channel_id
          ?? this.findBrowseId(candidate.endpoint)
          ?? this.findBrowseId(candidate.navigationEndpoint)
          ?? "",
        name: candidate.name ?? candidate.text ?? "",
      };
    };
    const candidates = item.artists?.length
      ? item.artists
      : item.authors?.length
        ? item.authors
        : item.author
          ? [item.author]
          : [];
    const artists = candidates
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);

    if (artists.length > 0) return artists;

    const unlinkedArtists = candidates
      .map(toArtistReference)
      .filter((artist) => artist.name);

    if (unlinkedArtists.length > 0) return unlinkedArtists;

    const runs = item.subtitle?.runs ?? [];
    const fromRuns = runs
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);
    return fromRuns.length > 0 ? fromRuns : undefined;
  }

  private findBrowseId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        browseId?: unknown;
        payload?: unknown;
      };
      if (typeof candidate.browseId === "string") return candidate.browseId;
      const payloadBrowseId = visit(candidate.payload);
      if (payloadBrowseId) return payloadBrowseId;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findAlbumPlaylistId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        playlistId?: unknown;
        watchPlaylistEndpoint?: { playlistId?: unknown };
        watchEndpoint?: { playlistId?: unknown };
        payload?: { playlistId?: unknown };
      };
      const playlistId = candidate.watchPlaylistEndpoint?.playlistId
        ?? candidate.watchEndpoint?.playlistId
        ?? candidate.payload?.playlistId
        ?? candidate.playlistId;
      if (typeof playlistId === "string" && playlistId.length > 0) {
        if (playlistId.startsWith("OLAK5uy_")) return playlistId;
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findStringByKey(root: unknown, keys: Set<string>): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (keys.has(key) && typeof child === "string" && child.length > 0) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findYoutubeChannelId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const child of Object.values(value)) {
        if (typeof child === "string" && /^UC[\w-]{20,}$/.test(child)) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private parseViewCount(value?: string): number | undefined {
    if (!value) return undefined;
    const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const multiplier = match[2]?.toUpperCase() === "B"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
    return Math.round(amount * multiplier);
  }

  private getViewCountText(item: MusicItem): string | undefined {
    if (item.views) return item.views;
    const texts = [
      ...(item.fixed_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      ...(item.flex_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      item.subtitle?.toString(),
      ...(item.subtitle?.runs?.map((run) => run.text) ?? []),
    ].filter((value): value is string => Boolean(value));
    return texts.find((value) => /\bviews?\b|\bplays?\b/i.test(value))
      ?? texts.find((value) => /^\s*\d+(?:[.,]\d+)?\s*[KMB]\s*$/i.test(value));
  }

  private getColumnText(column: MusicColumn): string | undefined {
    return column.title?.toString()
      || column.title?.runs?.map((run) => run.text).filter(Boolean).join("");
  }

  private isArtistColumn(column: MusicColumn): boolean {
    return column.title?.runs?.some((run) => {
      const browseId = this.findBrowseId(run.endpoint) ?? this.findBrowseId(run.navigationEndpoint);
      return browseId?.startsWith("UC");
    }) ?? false;
  }

  private isAlbumColumn(column: MusicColumn): boolean {
    return column.title?.runs?.some((run) => {
      const browseId = this.findBrowseId(run.endpoint) ?? this.findBrowseId(run.navigationEndpoint);
      return Boolean(browseId && !browseId.startsWith("UC"));
    }) ?? false;
  }

  private getTrackAlbumName(item: MusicItem): string | undefined {
    const title = this.getTitle(item);
    const artistNames = new Set(
      [
        this.getArtistName(item),
        ...(this.getArtists(item)?.map((artist) => artist.name) ?? []),
      ]
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    );

    const linkedAlbum = (item.flex_columns ?? [])
      .slice(1)
      .find((column) => this.isAlbumColumn(column));
    const linkedAlbumText = linkedAlbum ? this.getColumnText(linkedAlbum)?.trim() : undefined;
    if (linkedAlbumText) return linkedAlbumText;

    const candidates = [
      ...(item.flex_columns ?? [])
        .slice(1)
        .filter((column) => !this.isArtistColumn(column))
        .map((column) => this.getColumnText(column)),
      ...(item.fixed_columns ?? []).map((column) => this.getColumnText(column)),
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));

    return candidates.find((value) => {
      const normalized = value.toLocaleLowerCase();
      return normalized !== title?.toLocaleLowerCase()
        && !artistNames.has(normalized)
        && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)
        && !/\bviews?\b|\bplays?\b/i.test(value);
    });
  }

  private getTitle(item: MusicItem): string | null {
    if (typeof item.title === "string") return item.title;
    const title = item.title?.toString();
    return title || null;
  }

  private getPlaylistItemId(item: MusicItem): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        action?: unknown;
        setVideoId?: unknown;
      };
      if (
        candidate.action === "ACTION_REMOVE_VIDEO"
        && typeof candidate.setVideoId === "string"
      ) {
        return candidate.setVideoId;
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(item.menu);
  }

  private toAlbum(item: MusicItem): Album | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    return {
      id,
      playlistId: this.findAlbumPlaylistId(item),
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      artworkUrl: this.getArtwork(item),
    };
  }

  private toPlaylist(item: MusicItem): Playlist | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    const owner = this.getArtistName(item);
    return {
      id,
      title,
      owner: owner === "Unknown artist" ? "YouTube Music playlist" : owner,
      artworkUrl: this.getArtwork(item),
      isSaved: false,
    };
  }

  private toTrack(item: MusicItem): Track | null {
    const id = item.id ?? item.endpoint?.payload?.videoId;
    const title = this.getTitle(item);
    if (!id || !title) return null;
    const viewCountText = this.getViewCountText(item);

    return {
      id,
      source: "youtube",
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      album: this.getTrackAlbumName(item),
      artworkUrl: this.getArtwork(item) ?? getVideoArtworkFallback(id),
      playlistItemId: this.getPlaylistItemId(item),
      viewCount: this.parseViewCount(viewCountText),
      viewCountText,
    };
  }

  private toAlbumTrack(item: MusicItem, album: Album): Track | null {
    const track = this.toTrack(item);
    if (!track) return null;
    if (track.artist && track.artist !== "Unknown artist") return track;

    const fallbackArtist = album.artist && album.artist !== "Unknown artist"
      ? album.artist
      : undefined;
    if (!fallbackArtist) return track;

    return {
      ...track,
      artist: fallbackArtist,
      artists: track.artists?.length
        ? track.artists
        : album.artists?.length === 1
          ? album.artists
          : undefined,
    };
  }

  private toArtist(item: MusicItem): Artist | null {
    const id = item.id
      ?? this.findBrowseId(item.endpoint)
      ?? this.findBrowseId(item.on_tap)
      ?? this.findYoutubeChannelId(item);
    const name = this.getTitle(item) ?? item.author?.name ?? item.artists?.[0]?.name;
    if (!id?.startsWith("UC") || !name) return null;
    return {
      id,
      name,
      artworkUrl: this.getArtwork(item),
      subscriberCount: item.subscribers,
    };
  }

  private artistsFromReferences(
    items: Array<Track | Album>,
    query: string,
  ): Artist[] {
    const normalizedQuery = query.toLocaleLowerCase();
    const normalizedQueryKey = this.normalizeSearchKey(query);
    return items.flatMap((item) =>
      (item.artists ?? [])
        .filter((artist) => {
          const artistKey = this.normalizeSearchKey(artist.name);
          return artist.id.startsWith("UC")
          && artist.name
          && (
            artist.name.toLocaleLowerCase() === normalizedQuery
            || artist.name.toLocaleLowerCase().includes(normalizedQuery)
            || normalizedQuery.includes(artist.name.toLocaleLowerCase())
            || (artistKey && normalizedQueryKey && artistKey === normalizedQueryKey)
            || (artistKey && normalizedQueryKey && artistKey.includes(normalizedQueryKey))
            || (artistKey && normalizedQueryKey && normalizedQueryKey.includes(artistKey))
          );
        })
        .map((artist) => ({
          id: artist.id,
          name: artist.name,
      }))
    );
  }

  private collectArtistCardItems(root: unknown): MusicItem[] {
    const results: MusicItem[] = [];
    const seen = new WeakSet<object>();

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const item = value as MusicItem;
      const id = this.findBrowseId(item.on_tap);
      const title = this.getTitle(item);
      const subtitle = item.subtitle?.toString() ?? "";
      const header = item.header?.title?.toString() ?? "";
      const badgeLabels = item.subtitle_badges
        ?.map((badge) => badge.label)
        .filter(Boolean)
        .join(" ") ?? "";
      const typeText = `${header} ${subtitle} ${badgeLabels} ${item.end_icon_type ?? ""}`;
      if (
        id?.startsWith("UC")
        && title
        && this.getArtwork(item)
        && /\bartist\b|\bsubscribers?\b|MUSIC_EXPLICIT_BADGE/i.test(typeText)
      ) {
        results.push({
          ...item,
          id,
          item_type: "artist",
          subscribers: item.subscribers
            ?? subtitle.match(/[\d,.]+\s*[KMB]?\s+subscribers?/i)?.[0],
        });
      }

      for (const child of Object.values(value)) {
        if (Array.isArray(child) || (child && typeof child === "object")) {
          visit(child);
        }
      }
    };

    visit(root);
    return results;
  }

  private collectMusicItems(root: unknown, acceptedTypes: Set<string>): MusicItem[] {
    const results: MusicItem[] = [];
    const seen = new WeakSet<object>();
    const response = root as ParsedMusicResponse;
    const nodeTypes = [YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem];

    for (const memo of [response.contents_memo, response.continuation_contents_memo]) {
      if (!memo) continue;
      for (const item of memo.getType(...nodeTypes)) {
        if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
          results.push(item);
        }
      }
    }

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const item = value as MusicItem;
      if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
        results.push(item);
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);
    return results;
  }

  private normalizePlaylistId(playlistId: string): string {
    return playlistId.replace(/^VL/, "");
  }

  private getPlaylistBrowseIds(playlistId: string): string[] {
    const normalizedId = this.normalizePlaylistId(playlistId);
    return [...new Set([playlistId, normalizedId, `VL${normalizedId}`])];
  }

  private findEditablePlaylistId(root: unknown): string | undefined {
    const response = root as ParsedMusicResponse;
    const editableHeader = response.contents_memo
      ?.getType(YTNodes.MusicEditablePlaylistDetailHeader)?.[0] as {
        playlist_id?: string;
      } | undefined;
    if (editableHeader?.playlist_id) return editableHeader.playlist_id;

    return this.findStringByKey(root, new Set(["playlist_id", "playlistId"]));
  }

  private uniqueById<T extends { id: string }>(items: T[]): T[] {
    const byId = new Map<string, T>();
    for (const item of items) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, item);
        continue;
      }
      byId.set(item.id, {
        ...item,
        ...Object.fromEntries(
          Object.entries(existing).filter(([, value]) => value !== undefined && value !== ""),
        ),
      } as T);
    }
    return [...byId.values()];
  }

  private findLikeEndpoint(root: unknown, status: "LIKE" | "INDIFFERENT"): RawLikeEndpoint | null {
    const seen = new WeakSet<object>();
    let match: RawLikeEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { likeEndpoint?: RawLikeEndpoint };
      if (candidate.likeEndpoint?.status === status) {
        match = candidate.likeEndpoint;
        return;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match;
  }

  private findLibraryToggleEndpoint(root: unknown): LibraryToggleEndpoint | null {
    const seen = new WeakSet<object>();
    let fallback: LibraryToggleEndpoint | null = null;
    let match: LibraryToggleEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as {
        type?: string;
        is_toggled?: boolean;
        endpoint?: CallableEndpoint;
        toggled_endpoint?: CallableEndpoint;
        icon_type?: string;
        tooltip?: string;
        toggled_tooltip?: string;
      };
      if (
        candidate.type === "ToggleButton"
        && candidate.endpoint
        && candidate.toggled_endpoint
        && candidate.icon_type !== "LIKE"
        && candidate.icon_type !== "DISLIKE"
      ) {
        const toggle = {
          isToggled: candidate.is_toggled,
          endpoint: candidate.endpoint,
          toggledEndpoint: candidate.toggled_endpoint,
          iconType: candidate.icon_type,
          tooltip: candidate.tooltip,
          toggledTooltip: candidate.toggled_tooltip,
        };
        const text = `${candidate.tooltip ?? ""} ${candidate.toggled_tooltip ?? ""}`.toLocaleLowerCase();
        if (text.includes("library") || text.includes("save")) {
          match = toggle;
          return;
        }
        fallback ??= toggle;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match ?? fallback;
  }

  private rawText(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return "";

    const text = value as {
      text?: string;
      simpleText?: string;
      runs?: Array<{ text?: string }>;
      accessibility?: {
        accessibilityData?: {
          label?: string;
        };
      };
    };
    return text.simpleText
      ?? text.text
      ?? text.runs?.map((run) => run.text).filter(Boolean).join("")
      ?? text.accessibility?.accessibilityData?.label
      ?? "";
  }

  private findRawLibraryToggle(root: unknown): RawToggleButtonRenderer | null {
    const seen = new WeakSet<object>();
    let fallback: RawToggleButtonRenderer | null = null;
    let match: RawToggleButtonRenderer | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { toggleButtonRenderer?: RawToggleButtonRenderer };
      const toggle = candidate.toggleButtonRenderer;
      if (toggle) {
        const iconType = toggle.defaultIcon?.iconType;
        if (iconType !== "LIKE" && iconType !== "DISLIKE") {
          const hasDefaultEndpoint = Boolean(toggle.defaultServiceEndpoint);
          const hasToggledEndpoint = Boolean(toggle.toggledServiceEndpoint);
          const hasEndpoints = hasDefaultEndpoint || hasToggledEndpoint;

          if (hasEndpoints) {
            const text = `${toggle.defaultTooltip ?? ""} ${toggle.toggledTooltip ?? ""}`.toLocaleLowerCase();
            if (text.includes("library") || text.includes("save")) {
              match = toggle;
              return;
            }
            fallback ??= toggle;
          }
        }
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    const result = (match ?? fallback) as RawToggleButtonRenderer | null;
    if (result) {
      logInternalInfo("YouTubeMusicDataSource.findRawLibraryToggle found toggle", {
        source: match ? "tooltip" : "fallback",
        iconType: result.defaultIcon?.iconType,
        defaultTooltip: result.defaultTooltip,
        toggledTooltip: result.toggledTooltip,
      });
    } else {
      logInternalWarn("YouTubeMusicDataSource.findRawLibraryToggle no toggle found");
    }
    return result;
  }

  private findRawLibraryMenuToggle(root: unknown): RawToggleMenuServiceItemRenderer | null {
    const seen = new WeakSet<object>();
    let fallback: RawToggleMenuServiceItemRenderer | null = null;
    let match: RawToggleMenuServiceItemRenderer | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { toggleMenuServiceItemRenderer?: RawToggleMenuServiceItemRenderer };
      const toggle = candidate.toggleMenuServiceItemRenderer;
      if (toggle) {
        const iconType = toggle.defaultIcon?.iconType;
        const toggledIconType = toggle.toggledIcon?.iconType;
        if (
          iconType !== "LIKE"
          && iconType !== "DISLIKE"
          && toggledIconType !== "LIKE"
          && toggledIconType !== "DISLIKE"
        ) {
          const hasDefaultEndpoint = Boolean(toggle.defaultServiceEndpoint);
          const hasToggledEndpoint = Boolean(toggle.toggledServiceEndpoint);
          const hasEndpoints = hasDefaultEndpoint || hasToggledEndpoint;

          if (hasEndpoints) {
            const text = `${this.rawText(toggle.defaultText)} ${this.rawText(toggle.toggledText)}`.toLocaleLowerCase();
            if (text.includes("library") || text.includes("save")) {
              match = toggle;
              return;
            }
            fallback ??= toggle;
          }
        }
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    const result = (match ?? fallback) as RawToggleMenuServiceItemRenderer | null;
    if (result) {
      const toggle = result as RawToggleMenuServiceItemRenderer;
      logInternalInfo("YouTubeMusicDataSource.findRawLibraryMenuToggle found toggle", {
        source: match ? "text" : "fallback",
        iconType: toggle.defaultIcon?.iconType,
        toggledIconType: toggle.toggledIcon?.iconType,
        defaultText: this.rawText(toggle.defaultText),
        toggledText: this.rawText(toggle.toggledText),
      });
    } else {
      logInternalWarn("YouTubeMusicDataSource.findRawLibraryMenuToggle no toggle found");
    }
    return result;
  }

  private findArtistSubscriptionToggle(root: unknown): { subscribed: boolean } | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): { subscribed: boolean } | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const candidate = value as {
        subscribeButtonRenderer?: {
          subscribed?: boolean;
          channelId?: string;
          notificationPreferenceButton?: unknown;
          targetId?: string;
        };
      };
      const renderer = candidate.subscribeButtonRenderer;
      if (renderer) {
        return { subscribed: Boolean(renderer.subscribed) };
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private findSubscribeButtonUpdate(root: unknown, artistId: string): { subscribed: boolean } | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): { subscribed: boolean } | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const candidate = value as {
        updateSubscribeButtonAction?: {
          subscribed?: boolean;
          channelId?: string;
        };
      };
      const action = candidate.updateSubscribeButtonAction;
      if (action && (!action.channelId || action.channelId === artistId)) {
        return { subscribed: Boolean(action.subscribed) };
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private findRunAttestationCommand(root: unknown): AttestationCommand | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): AttestationCommand | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const command = (value as { runAttestationCommand?: AttestationCommand }).runAttestationCommand;
      if (command) return command;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private getArtistCacheKey(artistId: string): string {
    return `youtube-music:artist:${ARTIST_CACHE_VERSION}:${artistId}`;
  }

  private getArtistSubscriptionOverride(artistId: string): boolean | undefined {
    const override = this.artistSubscriptionOverrides.get(artistId);
    if (!override) return undefined;
    if (override.expiresAt <= Date.now()) {
      this.artistSubscriptionOverrides.delete(artistId);
      return undefined;
    }
    return override.subscribed;
  }

  private rememberArtistSubscription(artistId: string, subscribed: boolean): void {
    this.artistSubscriptionOverrides.set(artistId, {
      subscribed,
      expiresAt: Date.now() + ARTIST_SUBSCRIPTION_OVERRIDE_MS,
    });
  }

  private async updateCachedArtistSubscription(artistId: string, subscribed: boolean): Promise<void> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (!cached) return;
    await setCachedJson(cacheKey, {
      ...cached,
      subscribed,
    });
  }

  private async updateCachedAlbumSaved(album: Album, saved: boolean): Promise<void> {
    const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
    if (!cachedLibrary) return;

    const sameAlbum = (item: Album) =>
      item.id === album.id
      || Boolean(album.playlistId && item.playlistId === album.playlistId)
      || Boolean(album.playlistId && item.id === album.playlistId)
      || Boolean(item.playlistId && item.playlistId === album.id);
    const albums = saved
      ? [album, ...cachedLibrary.albums.filter((item) => !sameAlbum(item))]
      : cachedLibrary.albums.filter((item) => !sameAlbum(item));

    await setCachedJson(LIBRARY_CACHE_KEY, {
      ...cachedLibrary,
      albums,
    });
  }

  private getActionableServiceEndpoint(endpoint: RawServiceEndpoint): RawServiceEndpoint {
    const commands = endpoint.commandExecutorCommand?.commands;
    if (!commands?.length) return endpoint;
    return commands.find((command) => command.feedbackEndpoint || command.likeEndpoint)
      ?? commands[commands.length - 1]
      ?? endpoint;
  }

  private async executeRawServiceEndpoint(
    client: Innertube,
    endpoint: RawServiceEndpoint,
  ): Promise<{ success?: boolean; status_code?: number }> {
    const command = this.getActionableServiceEndpoint(endpoint);
    if (command.feedbackEndpoint?.feedbackToken) {
      const feedback = command.feedbackEndpoint;
      return client.actions.execute("/feedback", {
        feedbackTokens: [feedback.feedbackToken],
        ...(feedback.cpn ? { feedbackContext: { cpn: feedback.cpn } } : {}),
        isFeedbackTokenUnencrypted: Boolean(feedback.isFeedbackTokenUnencrypted),
        shouldMerge: Boolean(feedback.shouldMerge),
      });
    }
    if (command.likeEndpoint) {
      const like = command.likeEndpoint;
      const params = like.status === "LIKE"
        ? like.likeParams ?? like.params
        : like.removeLikeParams ?? like.params;
      return client.actions.execute(
        like.status === "LIKE" ? "/like/like" : "/like/removelike",
        {
          client: "YTMUSIC",
          target: this.normalizeLikeTarget(like.target),
          ...(params ? { params } : {}),
        },
      );
    }
    throw new Error("YouTube Music returned an unsupported album library command.");
  }

  private normalizeLikeTarget(target: RawLikeEndpoint["target"]): RawLikeEndpoint["target"] {
    if (!target || typeof target !== "string") return target;
    if (target.startsWith("PL") || target.startsWith("OLAK5uy_")) {
      return { playlistId: target };
    }
    return { videoId: target };
  }

  private async executePlaylistLibraryLikeCommand(
    client: Innertube,
    playlistId: string,
    saved: boolean,
  ): Promise<{ success?: boolean; status_code?: number }> {
    return client.actions.execute(saved ? "/like/like" : "/like/removelike", {
      client: "YTMUSIC",
      target: {
        playlistId,
      },
    });
  }

  private async executeTrackLikeCommand(
    musicClient: Innertube,
    trackId: string,
    liked: boolean,
  ) {
    const musicNextResponse = await musicClient.actions.execute("/next", {
      videoId: trackId,
      client: "YTMUSIC",
    });
    const status = liked ? "LIKE" : "INDIFFERENT";
    let endpoint = this.findLikeEndpoint(musicNextResponse.data, status);
    let endpointSource = "music";

    if (!endpoint?.target) {
      const webClient = await this.getWebClient();
      const webNextResponse = await webClient.actions.execute("/next", {
        videoId: trackId,
      });
      endpoint = this.findLikeEndpoint(webNextResponse.data, status);
      endpointSource = "web";
    }

    if (!endpoint?.target) {
      logInternalError("YouTubeMusicDataSource.executeTrackLikeCommand missing endpoint", {
        trackId,
        status,
      });
      throw new Error(`YouTube did not return a ${status} command for this song.`);
    }

    const params = liked
      ? endpoint.likeParams ?? endpoint.params
      : endpoint.removeLikeParams ?? endpoint.params;
    const path = liked ? "/like/like" : "/like/removelike";

    logInternalInfo("YouTubeMusicDataSource.executeTrackLikeCommand", {
      trackId,
      status,
      hasParams: Boolean(params),
      endpointSource,
    });

    return musicClient.actions.execute(path, {
      client: "YTMUSIC",
      target: this.normalizeLikeTarget(endpoint.target),
      ...(params ? { params } : {}),
    });
  }

  private getMusicContinuation(client: Innertube, root: unknown): MusicContinuation | null {
    const parsed = root as ParsedMusicResponse;
    const contentShelf = parsed.contents_memo?.getType(YTNodes.MusicPlaylistShelf)?.[0] as
      | { continuation?: unknown }
      | undefined;
    const continuationShelf = parsed.continuation_contents_memo?.getType(YTNodes.MusicPlaylistShelf)?.[0] as
      | { continuation?: unknown }
      | undefined;
    const shelfContinuation = contentShelf?.continuation ?? continuationShelf?.continuation;
    if (typeof shelfContinuation === "string" && shelfContinuation.length > 0) {
      return {
        key: shelfContinuation,
        load: () => this.executeMusicBrowse(client, {
          continuation: shelfContinuation,
        }),
      };
    }

    const seen = new WeakSet<object>();
    const found: {
      endpoint: {
        payload?: { continuation?: string };
        call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
      } | null;
    } = {
      endpoint: null,
    };
    let tokenContinuation: string | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || found.endpoint) return;
      if (seen.has(value)) return;
      seen.add(value);

      if (value instanceof YTNodes.ContinuationItem) {
        found.endpoint = value.endpoint as {
          payload?: { continuation?: string };
          call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
        };
        return;
      }

      const candidate = value as {
        continuation?: unknown;
        contents?: unknown;
      };
      if (
        !tokenContinuation
        && typeof candidate.continuation === "string"
        && candidate.continuation
        && candidate.contents
      ) {
        tokenContinuation = candidate.continuation;
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);

    if (found.endpoint) {
      const endpoint = found.endpoint;
      const key = endpoint.payload?.continuation || `endpoint:${JSON.stringify(endpoint.payload ?? {})}`;
      return {
        key,
        load: () => endpoint.call(client.actions, { parse: true }),
      };
    }

    if (tokenContinuation) {
      const continuation = tokenContinuation;
      return {
        key: continuation,
        load: () => this.executeMusicBrowse(client, {
          continuation,
        }),
      };
    }

    return null;
  }

  private async collectAllTracks(client: Innertube, initialResponse: unknown): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (true) {
      items.push(...this.collectMusicItems(response, new Set(["song", "video"])));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllTracks repeated continuation", {
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      response = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectAllTracks complete", {
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async collectAllAlbumTracks(client: Innertube, initialResponse: unknown, album: Album): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (true) {
      items.push(...this.collectMusicItems(response, new Set(["song", "video"])));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllAlbumTracks repeated continuation", {
          albumId: album.id,
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      response = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toAlbumTrack(item, album)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectAllAlbumTracks complete", {
      albumId: album.id,
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async collectPlaylistTracks(client: Innertube, playlistId: string): Promise<Track[]> {
    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    let page = await this.executeMusicBrowse(client, { browseId });
    let pageCount = 0;
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();

    while (true) {
      const pageItems = this.collectMusicItems(page, new Set(["song", "video"]));
      items.push(...pageItems);
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, page);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracks repeated page", {
          playlistId,
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      page = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectPlaylistTracks complete", {
      playlistId,
      browseId,
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async waitForPlaylistEmptyRetry(attempt: number): Promise<void> {
    const delayMs = PLAYLIST_EMPTY_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
  }

  private async collectPlaylistTracksWithEmptyRetries(
    client: Innertube,
    playlistId: string,
    source: string,
  ): Promise<Track[]> {
    for (let attempt = 0; attempt < PLAYLIST_EMPTY_RETRY_DELAYS_MS.length; attempt += 1) {
      await this.waitForPlaylistEmptyRetry(attempt);

      const tracks = await this.collectPlaylistTracks(client, playlistId);
      if (tracks.length > 0) return tracks;

      const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
      logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracksWithEmptyRetries retrying empty response", {
        playlistId,
        browseId,
        source,
        attempt: attempt + 1,
      });

      const response = await this.executeMusicBrowse(client, { browseId });
      const fallbackTracks = await this.collectAllTracks(client, response);
      if (fallbackTracks.length > 0) return fallbackTracks;
    }

    return [];
  }

  private createPlaylistPageKey(playlistId: string): string {
    return `${playlistId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  private pruneExpiredPlaylistPageSessions() {
    const now = Date.now();
    for (const [key, session] of this.playlistPageSessions) {
      if (session.expiresAt <= now) {
        this.playlistPageSessions.delete(key);
      }
    }
  }

  private collectParsedPlaylistPageTracks(page: YouTubeMusicPlaylistPage, seenTrackIds: Set<string>): Track[] {
    const items = page.items ?? page.contents ?? [];
    const tracks: Track[] = [];

    for (const item of items) {
      const track = this.toTrack(item);
      if (!track || seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      tracks.push(track);
    }

    return tracks;
  }

  private getPlaylistTrackCacheKey(playlistId: string): string {
    return `youtube-music:playlist-tracks:${PLAYLIST_TRACK_CACHE_VERSION}:${playlistId}`;
  }

  private async cachePlaylistTracks(playlistId: string, tracks: Track[]): Promise<Track[]> {
    if (tracks.length === 0) return tracks;
    const cacheKey = this.getPlaylistTrackCacheKey(playlistId);
    const cached = await getCachedJson<Track[]>(cacheKey);
    const merged = this.uniqueById([...(cached ?? []), ...tracks]);
    await setCachedJson(cacheKey, merged);
    return merged;
  }

  private async getCachedPlaylistFallback(
    playlistId: string,
    cachedTracks?: Track[] | null,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage | null> {
    const tracks = cachedTracks ?? await getCachedJson<Track[]>(this.getPlaylistTrackCacheKey(playlistId));
    const page = createCachedPlaylistFallback(tracks);
    if (!page) return null;

    onUpdate?.(page);
    logInternalWarn("YouTubeMusicDataSource.getCachedPlaylistFallback using cached playlist", {
      playlistId,
      trackCount: page.tracks.length,
    });
    return page;
  }

  private getAlbumHeaderArtwork(response: unknown): string | undefined {
    const parsed = response as ParsedMusicResponse;
    const detailHeader = parsed.contents_memo?.getType(YTNodes.MusicDetailHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;
    const responsiveHeader = parsed.contents_memo?.getType(YTNodes.MusicResponsiveHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;

    return selectArtworkUrl(
      detailHeader?.thumbnails,
      detailHeader?.thumbnail?.contents,
      responsiveHeader?.thumbnails,
      responsiveHeader?.thumbnail?.contents,
    );
  }

  private async enrichMissingAlbumArtwork(client: Innertube, albums: Album[]): Promise<Album[]> {
    const missingAlbums = albums.filter((album) => !album.artworkUrl);
    if (missingAlbums.length === 0) return albums;

    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork start", {
      missingCount: missingAlbums.length,
      albumIds: missingAlbums.map((album) => album.id),
    });

    const artworkByAlbumId = new Map<string, string>();
    const queue = [...missingAlbums];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const album = queue.shift();
        if (!album) return;

        try {
          const response = await this.executeMusicBrowse(client, { browseId: album.id });
          const artworkUrl = this.getAlbumHeaderArtwork(response);
          if (artworkUrl) artworkByAlbumId.set(album.id, artworkUrl);
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.enrichMissingAlbumArtwork album failed", {
            albumId: album.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    await Promise.all(workers);
    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork complete", {
      missingCount: missingAlbums.length,
      resolvedCount: artworkByAlbumId.size,
    });

    return albums.map((album) => {
      const artworkUrl = artworkByAlbumId.get(album.id);
      return artworkUrl ? { ...album, artworkUrl } : album;
    });
  }

  private async getCreatedPlaylists(client: Innertube, playlistLibrary: unknown): Promise<Playlist[]> {
    const playlistItems = this.collectMusicItems(playlistLibrary, new Set(["playlist"]));
    const playlists = this.uniqueById(
      playlistItems
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item))
        .filter((item) => {
          const normalizedId = item.id.replace(/^VL/, "").toUpperCase();
          if (normalizedId === "LM") return false;
          const lowerTitle = item.title.toLocaleLowerCase();
          if (lowerTitle === "liked songs" || lowerTitle === "likes" || lowerTitle.includes("new releases") || lowerTitle.includes("new episodes")) return false;
          return true;
        }),
    );
    const createdPlaylistIds = new Set<string>();
    const queue = [...playlists];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const playlist = queue.shift();
        if (!playlist) return;

        for (const browseId of this.getPlaylistBrowseIds(playlist.id)) {
          try {
            const response = await this.executeMusicBrowse(client, { browseId });
            const editablePlaylistId = this.findEditablePlaylistId(response);
            if (!editablePlaylistId) continue;

            const normalizedEditableId = this.normalizePlaylistId(editablePlaylistId);
            const normalizedPlaylistId = this.normalizePlaylistId(playlist.id);
            if (normalizedEditableId !== normalizedPlaylistId) continue;

            createdPlaylistIds.add(playlist.id);
            if (!playlist.artworkUrl) {
              playlist.artworkUrl = this.getAlbumHeaderArtwork(response);
            }
            break;
          } catch (error) {
            logInternalWarn("YouTubeMusicDataSource.getCreatedPlaylists playlist failed", {
              playlistId: playlist.id,
              browseId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    });

    await Promise.all(workers);
    return playlists.map((playlist) => ({
      ...playlist,
      isSaved: true,
      isEditable: createdPlaylistIds.has(playlist.id),
    }));
  }

  private async getLikedSongs(client: Innertube): Promise<{
    playlist: Playlist;
    tracks: Track[];
  }> {
    const tracks = await this.collectPlaylistTracks(client, LIKED_SONGS_PLAYLIST_ID);

    return {
      playlist: {
        id: LIKED_SONGS_PLAYLIST_ID,
        title: "Liked Songs",
        owner: "YouTube Music",
        kind: "liked-songs",
      },
      tracks,
    };
  }

  private async applyLibraryFilter(
    client: Innertube,
    response: unknown,
    filterName: string,
  ): Promise<unknown> {
    const parsed = response as ParsedMusicResponse;
    const chipCloud = parsed.contents_memo?.getType(YTNodes.ChipCloud)?.[0] as {
      chips?: Array<{
        text?: string;
        endpoint?: {
          call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
        };
      }>;
    } | undefined;
    const filter = chipCloud?.chips?.find((chip) => chip.text === filterName);
    if (!filter?.endpoint) {
      logInternalWarn("YouTubeMusicDataSource.applyLibraryFilter missing filter", {
        filterName,
        availableFilters: chipCloud?.chips?.map((chip) => chip.text).filter(Boolean) ?? [],
      });
      return response;
    }

    return filter.endpoint.call(client.actions, { parse: true });
  }

  private getRendererCounts(response: unknown): Record<string, number> {
    const parsed = response as ParsedMusicResponse;
    const counts: Record<string, number> = {};
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const [renderer, items] of memo.entries()) {
        counts[renderer] = (counts[renderer] ?? 0) + items.length;
      }
    }
    return counts;
  }

  private getResponseMessages(response: unknown): string[] {
    const parsed = response as ParsedMusicResponse;
    const messages: string[] = [];
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const message of memo.getType(YTNodes.Message) as Array<{ text?: { toString(): string } }>) {
        const text = message.text?.toString();
        if (text) messages.push(text);
      }
    }
    return messages;
  }

  private async executeMusicBrowse(client: Innertube, args: Record<string, unknown>): Promise<unknown> {
    return client.actions.execute("/browse", {
      ...args,
      parse: true,
    });
  }

  private async loadLibraryResponses(client: Innertube) {
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses start", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
    });
    const [libraryLanding, historyResponse] = await Promise.all([
      this.executeMusicBrowse(client, { browseId: "FEmusic_library_landing" }),
      this.executeMusicBrowse(client, { browseId: "FEmusic_history" }),
    ]);
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses complete", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      libraryRenderers: this.getRendererCounts(libraryLanding),
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages: this.getResponseMessages(libraryLanding),
      historyMessages: this.getResponseMessages(historyResponse),
    });
    return { libraryLanding, historyResponse };
  }

  private getLibrarySignal(libraryLanding: unknown, historyResponse: unknown): number {
    const albumCount = this.collectMusicItems(libraryLanding, new Set(["album"])).length;
    const playlistCount = this.collectMusicItems(libraryLanding, new Set(["playlist"])).length;
    const recentCount = this.collectMusicItems(historyResponse, new Set(["song", "video"])).length;
    const messages = this.getResponseMessages(libraryLanding).length
      + this.getResponseMessages(historyResponse).length;
    return albumCount + playlistCount + recentCount - messages * 10;
  }

  private getLibraryAuthFailureMessage(libraryLanding: unknown, historyResponse: unknown): string | null {
    const libraryMessages = this.getResponseMessages(libraryLanding);
    const historyMessages = this.getResponseMessages(historyResponse);
    const allMessages = [...libraryMessages, ...historyMessages];
    const signedOutMessages = allMessages.filter((message) =>
      /sign in|explore your favorites|looking for what/i.test(message)
    );
    if (signedOutMessages.length === 0) return null;

    return [
      "YouTube Music did not accept the saved sign-in session for library sync.",
      `Account tried: ${this.musicAccountName} (authuser ${this.musicAccountIndex}).`,
      `YouTube response: ${signedOutMessages.join(" / ")}.`,
      "Please sign out, sign in again, and make sure the login window lands on music.youtube.com before it closes.",
    ].join(" ");
  }

  private findDelegatedPageId(endpoint: unknown): string | undefined {
    const datasync = this.findStringByKey(endpoint, new Set(["datasyncIdToken"]));
    const pageId = datasync?.split("||")[0]?.trim();
    if (pageId) return pageId;

    return this.findStringByKey(endpoint, new Set(["channelIdentifier", "externalChannelId"]))
      ?? this.findYoutubeChannelId(endpoint)
      ?? this.findBrowseId(endpoint);
  }

  private readPreferredAccountKey(): string | null {
    try {
      return localStorage.getItem(SELECTED_ACCOUNT_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private async getAccountCandidates(): Promise<AccountCandidate[]> {
    const fallback: AccountCandidate = { accountIndex: 0, name: "YouTube Music", selected: true };
    try {
      const client = await this.getWebClient();
      const accountItems = await client.account.getInfo(true) as Array<{
        account_name?: { toString(): string };
        account_byline?: { toString(): string };
        channel_handle?: { toString(): string };
        account_photo?: unknown;
        endpoint?: unknown;
        has_channel?: boolean;
        is_disabled?: boolean;
        is_selected?: boolean;
      }>;
      if (accountItems.length === 0 && this.signedIn) {
        logInternalWarn("YouTubeMusicDataSource.getAccountCandidates signed-out stub");
      }

      const candidates = accountItems
        .filter((item) => !item.is_disabled)
        .flatMap((item, index): AccountCandidate[] => {
          const endpoint = item.endpoint;
          const onBehalfOfUser = this.findDelegatedPageId(endpoint);
          const serializedDelegationContext = this.findStringByKey(
            endpoint,
            new Set(["selectedSerializedDelegationContext", "serializedDelegationContext"]),
          );
          const name = item.account_name?.toString()
            || item.channel_handle?.toString()
            || item.account_byline?.toString()
            || undefined;
          const artworkUrl = selectArtworkUrl(collectArtworkCandidates(item.account_photo));
          if (index === 0) {
            return [{ ...fallback, name, artworkUrl, selected: item.is_selected }];
          }
          if (!onBehalfOfUser && !serializedDelegationContext) return [];
          return [{
            accountIndex: 0,
            name,
            artworkUrl,
            onBehalfOfUser,
            serializedDelegationContext,
            selected: item.is_selected,
          }];
        });

      const unique = this.uniqueById(
        [...candidates, fallback].map((candidate) => ({
          ...candidate,
          id: accountCandidateKey(candidate),
        })),
      ).map(({ id: _id, ...candidate }) => candidate);

      logInternalInfo("YouTubeMusicDataSource.getAccountCandidates success", {
        rawItemCount: accountItems.length,
        rawEndpoints: accountItems.map((item) => {
          const endpoint = item.endpoint as { name?: string; payload?: unknown } | undefined;
          const tokens = (endpoint?.payload as { supportedTokens?: unknown[] } | undefined)
            ?.supportedTokens;
          return {
            endpointName: endpoint?.name,
            identityFields: Array.isArray(tokens)
              ? tokens.flatMap((entry) =>
                  entry && typeof entry === "object" ? Object.keys(entry) : [])
              : undefined,
            payloadKeys: endpoint?.payload && typeof endpoint.payload === "object"
              ? Object.keys(endpoint.payload)
              : undefined,
          };
        }),
        derivedIds: accountItems.map((item) => {
          const id = this.findDelegatedPageId(item.endpoint);
          return id
            ? { length: id.length, looksLikeChannel: id.startsWith("UC"), digitsOnly: /^\d+$/.test(id) }
            : null;
        }),
        rawItemNames: accountItems.map((item) => ({
          name: item.account_name?.toString(),
          handle: item.channel_handle?.toString(),
          hasPhoto: Boolean(item.account_photo),
          hasChannel: item.has_channel,
          disabled: item.is_disabled,
          selected: item.is_selected,
        })),
        candidateCount: unique.length,
        selectedCount: unique.filter((candidate) => candidate.selected).length,
        candidates: unique.map((candidate) => ({
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          selected: candidate.selected,
          name: candidate.name,
        })),
      });
      return unique;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getAccountCandidates failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [fallback];
    }
  }

  private async useAccountCandidate(
    candidate: AccountCandidate,
    options: { cacheClient?: boolean; retrievePlayer?: boolean } = {},
  ): Promise<Innertube> {
    const cacheClient = options.cacheClient ?? true;
    const retrievePlayer = options.retrievePlayer ?? true;
    const changed = this.musicAccountIndex !== candidate.accountIndex
      || this.musicOnBehalfOfUser !== (candidate.onBehalfOfUser ?? null)
      || this.musicSerializedDelegationContext !== (candidate.serializedDelegationContext ?? null);
    this.musicAccountIndex = candidate.accountIndex;
    this.musicOnBehalfOfUser = candidate.onBehalfOfUser ?? null;
    this.musicSerializedDelegationContext = candidate.serializedDelegationContext ?? null;
    this.musicAccountName = candidate.name ?? "YouTube Music";
    this.musicAccountArtworkUrl = candidate.artworkUrl ?? null;
    if (changed) {
      this.musicClientPromise = null;
      this.webClientPromise = null;
    }
    if (!cacheClient) {
      return this.createMusicClient(retrievePlayer);
    }
    return this.getMusicClient();
  }

  private async findBestLibraryResponses(initialClient: Innertube): Promise<LibraryResponses> {
    const fallback: AccountCandidate = {
      accountIndex: this.musicAccountIndex,
      name: this.musicAccountName,
      onBehalfOfUser: this.musicOnBehalfOfUser ?? undefined,
      serializedDelegationContext: this.musicSerializedDelegationContext ?? undefined,
      selected: true,
    };
    const initialResponses = await this.loadLibraryResponses(initialClient);
    let best: LibraryResponses = {
      client: initialClient,
      account: fallback,
      ...initialResponses,
    };
    let bestSignal = this.getLibrarySignal(best.libraryLanding, best.historyResponse);
    const profileCandidates = await this.getAccountCandidates();
    const preferredKey = this.readPreferredAccountKey();
    const preferred = preferredKey
      ? profileCandidates.find((candidate) => accountCandidateKey(candidate) === preferredKey)
      : undefined;
    if (preferred) {
      const client = await this.useAccountCandidate(preferred);
      const responses = await this.loadLibraryResponses(client);
      logInternalInfo("YouTubeMusicDataSource.findBestLibraryResponses using saved account", {
        name: preferred.name,
        hasOnBehalfOfUser: Boolean(preferred.onBehalfOfUser),
        hasSerializedDelegationContext: Boolean(preferred.serializedDelegationContext),
      });
      return { client, account: preferred, ...responses };
    }

    const activeProfile = profileCandidates.find(
      (candidate) => accountCandidateKey(candidate) === accountCandidateKey(best.account),
    );
    if (activeProfile) {
      best = { ...best, account: { ...best.account, ...activeProfile } };
      this.musicAccountName = activeProfile.name ?? this.musicAccountName;
      this.musicAccountArtworkUrl = activeProfile.artworkUrl ?? this.musicAccountArtworkUrl;
    }

    const authUserCandidates: AccountCandidate[] = bestSignal <= 0
      ? [1, 2, 3, 4, 5].map((accountIndex) => ({
          accountIndex,
          name: `YouTube Music account ${accountIndex + 1}`,
        }))
      : [];
    const candidates = this.uniqueById(
      [...profileCandidates, ...authUserCandidates].map((candidate) => ({
        ...candidate,
        id: accountCandidateKey(candidate),
      })),
    ).map(({ id: _id, ...candidate }) => candidate);

    for (const candidate of candidates) {
      if (accountCandidateKey(candidate) === accountCandidateKey(best.account)) continue;

      try {
        const client = await this.useAccountCandidate(candidate, {
          cacheClient: false,
          retrievePlayer: false,
        });
        const { libraryLanding, historyResponse } = await this.loadLibraryResponses(client);
        const signal = this.getLibrarySignal(libraryLanding, historyResponse);
        if (signal > bestSignal || (signal === bestSignal && candidate.selected && !best.account.selected)) {
          best = { client, account: candidate, libraryLanding, historyResponse };
          bestSignal = signal;
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.findBestLibraryResponses candidate failed", {
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.useAccountCandidate(best.account);
    logInternalInfo("YouTubeMusicDataSource.findBestLibraryResponses selected", {
      accountIndex: best.account.accountIndex,
      hasOnBehalfOfUser: Boolean(best.account.onBehalfOfUser),
      hasSerializedDelegationContext: Boolean(best.account.serializedDelegationContext),
      selected: best.account.selected,
      signal: bestSignal,
      name: best.account.name,
    });
    return best;
  }

  async restoreSession(): Promise<boolean> {
    logInternalInfo("YouTubeMusicDataSource.restoreSession start");
    try {
      const session = await refreshAuthSession();
      if (!session.authenticated || !session.youtubeLinked) {
        logInternalInfo("YouTubeMusicDataSource.restoreSession no linked account", {
          authenticated: session.authenticated,
          youtubeLinked: session.youtubeLinked,
        });
        this.signedIn = false;
        return false;
      }
      this.signedIn = true;
      await this.getMusicClient();
      logInternalInfo("YouTubeMusicDataSource.restoreSession success");
      return true;
    } catch (error) {
      this.signedIn = false;
      logInternalError("YouTubeMusicDataSource.restoreSession failed", error);
      return false;
    }
  }

  async signIn(onPrompt: (prompt: AuthPrompt) => void): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signIn start");
    this.signedIn = false;

    // Step 1: the OpenDeck account session gates the whole app (/login),
    // so an unauthenticated caller here is a programming error, not a
    // flow to rescue — the QR sign-in lives on the login page.
    const session = await refreshAuthSession();
    if (!session.authenticated) {
      throw new Error("Sign in to your OpenDeck account first.");
    }

    // Step 2: link the YouTube Music account via Google's device-code flow.
    const current = await getYouTubeLinkStatus();
    if (current.linked) {
      this.signedIn = true;
      await this.getMusicClient();
      logInternalInfo("YouTubeMusicDataSource.signIn already linked");
      return;
    }

    const started = await startYouTubeLink();
    const expiresInSec = started.expiresInSec ?? 300;
    onPrompt({
      verificationUrl: started.verificationUrl || "https://www.youtube.com/activate",
      userCode: started.userCode ?? "",
      expiresInSec,
    });

    const deadline = Date.now() + (expiresInSec + 45) * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2_000));
      const status = await getYouTubeLinkStatus();
      if (status.linked) {
        try {
          await clearCache();
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.signIn cache clear failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.signedIn = true;
        await refreshYouTubeLinkedFlag();
        this.resetMusicSessionSelection();
        await this.getMusicClient();
        logInternalInfo("YouTubeMusicDataSource.signIn success");
        return;
      }
      if (status.state === "error") {
        throw new Error(status.error ?? "YouTube Music sign-in failed.");
      }
      if (status.state === "idle") {
        throw new Error("YouTube Music sign-in was cancelled.");
      }
    }
    await cancelYouTubeLink().catch(() => undefined);
    throw new Error("YouTube Music sign-in timed out.");
  }

  async signOut(): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signOut start");
    this.signedIn = false;
    try {
      await unlinkYouTube();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signOut unlink failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await signOutGoogle();
    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signOut cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await refreshYouTubeLinkedFlag();
    this.resetMusicSessionSelection();
    logInternalInfo("YouTubeMusicDataSource.signOut success");
  }

  getCachedLibrary(): Promise<LibrarySnapshot | null> {
    return getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
  }

  async getLibrary(onUpdate?: (library: LibrarySnapshot) => void): Promise<LibrarySnapshot> {
    const cacheKey = LIBRARY_CACHE_KEY;
    const cached = await getCachedJson<LibrarySnapshot>(cacheKey);

    if (cached && this.hasLibraryContent(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshLibrary(cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getLibrary background refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getLibrary ignoring empty cache entry");
    }

    return (await this.refreshLibrary(cacheKey)).value;
  }

  /**
   * Loads the library through the server's TVHTML5 proxy.
   *
   * Returns null when the endpoint is unavailable (older server, network
   * failure) so the caller can fall back to the in-page WEB_REMIX path.
   * Throws only for auth-shaped failures that the caller should surface.
   */
  private async fetchLibraryFromServer(): Promise<LibrarySnapshot | null> {
    try {
      const payload = await fetchYouTubeLibrary();
      const toTrack = (item: {
        id: string;
        title: string;
        artist: string;
        artworkUrl?: string;
        durationSec?: number;
      }): Track => ({
        id: item.id,
        source: "youtube",
        title: item.title,
        artist: item.artist,
        durationSec: item.durationSec,
        artworkUrl: item.artworkUrl,
      });

      const likedSongs = payload.likedSongs.map(toTrack);
      const playlists: Playlist[] = payload.playlists
        .filter((playlist) => playlist.id !== LIKED_SONGS_PLAYLIST_ID)
        .map((playlist) => ({
          id: playlist.id,
          title: playlist.title,
          owner: playlist.owner,
          artworkUrl: playlist.artworkUrl,
          kind: "playlist",
          isEditable: false,
        }));

      return {
        account: {
          name: payload.account.name ?? this.musicAccountName,
          artworkUrl: this.musicAccountArtworkUrl ?? undefined,
        },
        albums: payload.albums.map((album) => ({
          id: album.id,
          title: album.title,
          artist: album.artist,
          artworkUrl: album.artworkUrl,
        })),
        playlists,
        likedSongsPlaylist: {
          id: LIKED_SONGS_PLAYLIST_ID,
          title: "Liked Music",
          owner: "You",
          artworkUrl: payload.playlists.find((p) => p.id === LIKED_SONGS_PLAYLIST_ID)?.artworkUrl,
          kind: "liked-songs",
          isEditable: false,
        },
        likedSongs,
        recentlyPlayed: payload.recentlyPlayed.map(toTrack),
      };
    } catch (error) {
      // 409 = nothing linked (the caller already checked), 401 = signed out:
      // both mean "use the normal path" rather than a hard failure.
      const message = error instanceof Error ? error.message : String(error);
      logInternalWarn("YouTubeMusicDataSource.fetchLibraryFromServer failed", { error: message });
      return null;
    }
  }

  private hasLibraryContent(library: LibrarySnapshot): boolean {
    return library.albums.length > 0
      || library.playlists.length > 0
      || library.likedSongs.length > 0
      || library.recentlyPlayed.length > 0;
  }

  private async refreshLibrary(cacheKey: string): Promise<{ changed: boolean; value: LibrarySnapshot }> {
    if (!this.libraryRefreshPromise) {
      this.libraryRefreshPromise = this.fetchLibraryFresh().finally(() => {
        this.libraryRefreshPromise = null;
      });
    }

    const value = await this.libraryRefreshPromise;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchLibraryFresh(): Promise<LibrarySnapshot> {
    logInternalInfo("YouTubeMusicDataSource.getLibrary start", {
      hasCookie: false,
      signedIn: this.signedIn,
      accountIndex: this.musicAccountIndex,
    });
    if (!this.signedIn) {
      throw new Error(
        "Your YouTube Music account is not connected yet. Open Settings → Account and use \"Connect YouTube Music\" first.",
      );
    }

    // The browser cannot read its own library: an OAuth token is rejected by
    // WEB_REMIX (the client a browser sends) with 400, so the server performs
    // the read with TVHTML5 and returns plain JSON. Fall through to the legacy
    // in-page path only when that endpoint is unavailable.
    const fromServer = await this.fetchLibraryFromServer();
    if (fromServer) {
      await this.cachePlaylistTracks(LIKED_SONGS_PLAYLIST_ID, fromServer.likedSongs);
      logInternalInfo("YouTubeMusicDataSource.getLibrary via server", {
        albumCount: fromServer.albums.length,
        playlistCount: fromServer.playlists.length,
        likedSongCount: fromServer.likedSongs.length,
        recentTrackCount: fromServer.recentlyPlayed.length,
      });
      return fromServer;
    }

    let client = await this.getMusicClient();
    const bestLibrary = await this.findBestLibraryResponses(client);
    client = bestLibrary.client;
    const { libraryLanding, historyResponse } = bestLibrary;
    const libraryMessages = this.getResponseMessages(libraryLanding);
    const authFailureMessage = this.getLibraryAuthFailureMessage(libraryLanding, historyResponse);
    if (authFailureMessage && this.getLibrarySignal(libraryLanding, historyResponse) <= 0) {
      throw new YouTubeMusicAuthError(authFailureMessage);
    }

    const [albumLibrary, playlistLibrary] = await Promise.all([
      this.applyLibraryFilter(client, libraryLanding, "Albums"),
      this.applyLibraryFilter(client, libraryLanding, "Playlists"),
    ]);

    const albumItems = this.collectMusicItems(albumLibrary, new Set(["album"]));
    const recentItems = this.collectMusicItems(historyResponse, new Set(["song", "video"]));
    const parsedAlbums = this.uniqueById(albumItems.map((item) => this.toAlbum(item)).filter((item): item is Album => Boolean(item)));
    const [albums, playlists, likedSongsResult] = await Promise.all([
      this.enrichMissingAlbumArtwork(client, parsedAlbums),
      this.getCreatedPlaylists(client, playlistLibrary),
      this.getLikedSongs(client),
    ]);
    const recentlyPlayed = this.uniqueById(recentItems.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)));
    const historyMessages = this.getResponseMessages(historyResponse);
    await this.cachePlaylistTracks(LIKED_SONGS_PLAYLIST_ID, likedSongsResult.tracks);

    if (libraryMessages.length > 0 && albums.length === 0) {
      throw new YouTubeMusicAuthError(
        authFailureMessage ?? `YouTube Music returned an account message: ${libraryMessages.join(" ")}`,
      );
    }

    logInternalInfo("YouTubeMusicDataSource.getLibrary success", {
      albumCount: albums.length,
      playlistCount: playlists.length,
      likedSongCount: likedSongsResult.tracks.length,
      recentTrackCount: recentlyPlayed.length,
      albumRenderers: this.getRendererCounts(albumLibrary),
      playlistRenderers: this.getRendererCounts(playlistLibrary),
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages,
      historyMessages,
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      accountName: this.musicAccountName,
    });

    return {
      account: {
        name: this.musicAccountName,
        artworkUrl: this.musicAccountArtworkUrl ?? undefined,
      },
      albums,
      playlists,
      likedSongsPlaylist: likedSongsResult.playlist,
      likedSongs: likedSongsResult.tracks,
      recentlyPlayed,
    };
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = `youtube-music:album-tracks:v4:${album.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshAlbumTracks(album, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getAlbumTracks background refresh failed", {
              albumId: album.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getAlbumTracks ignoring empty cache entry", {
        albumId: album.id,
      });
    }

    return (await this.refreshAlbumTracks(album, cacheKey)).value;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.signedIn) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    try {
      const client = await this.getMusicClient();
      const albumResponse = await this.executeMusicBrowse(client, { browseId: album.id });
      const albumPlaylistId = album.playlistId ?? this.findAlbumPlaylistId(albumResponse);
      if (albumPlaylistId) {
        try {
          const directResponse = await this.executePlaylistLibraryLikeCommand(client, albumPlaylistId, saved);
          if (directResponse.success === false) {
            throw new Error(`Album library update returned HTTP ${directResponse.status_code}.`);
          }
          logInternalInfo("YouTubeMusicDataSource.setAlbumSaved direct like command", {
            albumId: album.id,
            albumPlaylistId,
            saved,
          });
          await this.updateCachedAlbumSaved(album, saved);
          return;
        } catch (directError) {
          logInternalWarn("YouTubeMusicDataSource.setAlbumSaved direct like command failed", {
            albumId: album.id,
            albumPlaylistId,
            saved,
            error: directError instanceof Error ? directError.message : String(directError),
          });
        }
      }

      const rawToggle = this.findRawLibraryToggle(albumResponse);

      if (rawToggle) {
        if (rawToggle.isToggled === saved) {
          await this.updateCachedAlbumSaved(album, saved);
          return;
        }
        const endpoint = saved
          ? rawToggle.defaultServiceEndpoint
          : rawToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library command for this album.");
        }

        logInternalInfo("YouTubeMusicDataSource.setAlbumSaved raw command", {
          albumId: album.id,
          saved,
          iconType: rawToggle.defaultIcon?.iconType,
          defaultTooltip: rawToggle.defaultTooltip,
          toggledTooltip: rawToggle.toggledTooltip,
        });

        const response = await this.executeRawServiceEndpoint(client, endpoint);
        if (response.success === false) {
          throw new Error(`Album library update returned HTTP ${response.status_code}.`);
        }
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const rawMenuToggle = this.findRawLibraryMenuToggle(albumResponse);
      if (rawMenuToggle) {
        if (rawMenuToggle.isToggled === saved) {
          await this.updateCachedAlbumSaved(album, saved);
          return;
        }
        const endpoint = saved
          ? rawMenuToggle.defaultServiceEndpoint
          : rawMenuToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library menu command for this album.");
        }

        logInternalInfo("YouTubeMusicDataSource.setAlbumSaved raw menu command", {
          albumId: album.id,
          saved,
          iconType: rawMenuToggle.defaultIcon?.iconType,
          toggledIconType: rawMenuToggle.toggledIcon?.iconType,
          defaultText: this.rawText(rawMenuToggle.defaultText),
          toggledText: this.rawText(rawMenuToggle.toggledText),
        });

        const response = await this.executeRawServiceEndpoint(client, endpoint);
        if (response.success === false) {
          throw new Error(`Album library menu update returned HTTP ${response.status_code}.`);
        }
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const albumPage = await client.music.getAlbum(album.id);
      const toggle = this.findLibraryToggleEndpoint(albumPage.page);
      if (!toggle) {
        throw new Error("YouTube Music did not return a library command for this album.");
      }
      if (toggle.isToggled === saved) {
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const endpoint = saved ? toggle.endpoint : toggle.toggledEndpoint;
      if (!endpoint) {
        throw new Error("YouTube Music returned an incomplete library command for this album.");
      }

      logInternalInfo("YouTubeMusicDataSource.setAlbumSaved command", {
        albumId: album.id,
        saved,
        iconType: toggle.iconType,
        tooltip: toggle.tooltip,
        toggledTooltip: toggle.toggledTooltip,
      });

      const response = await endpoint.call(client.actions, { client: "YTMUSIC" });
      if (response.success === false) {
        throw new Error(`Album library update returned HTTP ${response.status_code}.`);
      }
      await this.updateCachedAlbumSaved(album, saved);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setAlbumSaved failed", error, {
        albumId: album.id,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this album."
          : "YouTube Music could not remove this album.",
      );
    }
  }

  private async refreshAlbumTracks(
    album: Album,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.albumRefreshPromises.get(album.id);
    if (!refresh) {
      refresh = this.fetchAlbumTracksFresh(album).finally(() => {
        this.albumRefreshPromises.delete(album.id);
      });
      this.albumRefreshPromises.set(album.id, refresh);
    }

    const value = await refresh;
    const changed = value.length > 0
      ? await setCachedJson(cacheKey, value)
      : false;
    return { changed, value };
  }

  private async fetchAlbumTracksFresh(album: Album): Promise<Track[]> {
    const client = await this.getMusicClient();
    const albumPage = await client.music.getAlbum(album.id);
    const initialItems = albumPage.contents
      .filter((item) => item.item_type === "song" || item.item_type === "video") as unknown as MusicItem[];
    const continuedTracks = await this.collectAllAlbumTracks(client, albumPage.page, album);
    const tracks = this.uniqueById([
      ...initialItems
        .map((item) => this.toAlbumTrack(item, album))
        .filter((item): item is Track => Boolean(item)),
      ...continuedTracks,
    ]);
    if (tracks.length === 0) {
      throw new Error(`YouTube Music returned no tracks for album ${album.id}.`);
    }
    return tracks;
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshArtist(artistId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getArtist background refresh failed", {
              artistId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshArtist(artistId, cacheKey)).value;
  }

  async setArtistSubscribed(artistId: string, subscribed: boolean): Promise<void> {
    if (!this.signedIn) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    try {
      const musicClient = await this.getMusicClient();
      const context = musicClient.session.context as {
        client?: {
          clientName?: string;
          clientVersion?: string;
          visitorData?: string;
        };
      };
      const endpoint = subscribed ? "subscribe" : "unsubscribe";
      const response = await tauriFetch(
        `https://music.youtube.com/youtubei/v1/subscription/${endpoint}?prettyPrint=false`,
        {
          method: "POST",
          headers: {
            Accept: "*/*",
            "Accept-Language": "*",
            "Content-Type": "application/json",
            "X-Goog-AuthUser": this.musicAccountIndex.toString(),
            ...(context.client?.visitorData
              ? { "X-Goog-Visitor-Id": context.client.visitorData }
              : {}),
            "X-Youtube-Client-Name": "67",
            "X-Youtube-Client-Version": context.client?.clientVersion ?? "1.20260609.07.00",
          },
          body: JSON.stringify({
            channelIds: [artistId],
            params: subscribed ? "EgIIAhgA" : "CgIIAhgA",
            context,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Artist subscription update returned HTTP ${response.status}.`);
      }
      const responseData = await response.json() as unknown;
      const buttonUpdate = this.findSubscribeButtonUpdate(responseData, artistId);
      const attestationCommand = this.findRunAttestationCommand(responseData);
      logInternalInfo("YouTubeMusicDataSource.setArtistSubscribed response", {
        artistId,
        subscribed,
        requestMode: "tauriFetch",
        hasButtonUpdate: Boolean(buttonUpdate),
        returnedSubscribed: buttonUpdate?.subscribed,
        hasAttestationCommand: Boolean(attestationCommand),
        attestationEngagementType: attestationCommand?.engagementType,
      });
      if (buttonUpdate && buttonUpdate.subscribed !== subscribed) {
        throw new Error("YouTube Music returned a different subscription state.");
      }
      this.rememberArtistSubscription(artistId, subscribed);
      await this.updateCachedArtistSubscription(artistId, subscribed);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setArtistSubscribed failed", error, {
        artistId,
        subscribed,
      });
      throw new Error(
        subscribed
          ? "YouTube Music could not subscribe to this artist."
          : "YouTube Music could not unsubscribe from this artist.",
      );
    }
  }

  private async refreshArtist(
    artistId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: ArtistPage }> {
    let refresh = this.artistRefreshPromises.get(artistId);
    if (!refresh) {
      refresh = this.fetchArtistFresh(artistId).finally(() => {
        this.artistRefreshPromises.delete(artistId);
      });
      this.artistRefreshPromises.set(artistId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async getArtistArtworkFromPage(artistId: string): Promise<Artist | null> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (cached?.artist.artworkUrl) return cached.artist;

    try {
      return (await this.refreshArtist(artistId, cacheKey)).value.artist;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getArtistArtworkFromPage failed", {
        artistId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async hydrateArtistArtwork(artists: Artist[]): Promise<Artist[]> {
    const priorityArtists = artists.slice(0, 4);
    const hydrated = await Promise.all(
      priorityArtists.map(async (artist) => {
        const pageArtist = await this.getArtistArtworkFromPage(artist.id);
        if (!pageArtist?.artworkUrl) return artist;
        return {
          ...artist,
          name: artist.name || pageArtist.name,
          artworkUrl: pageArtist.artworkUrl,
          subscriberCount: artist.subscriberCount || pageArtist.subscriberCount,
        };
      }),
    );

    return [...hydrated, ...artists.slice(priorityArtists.length)];
  }

  private async fetchArtistFresh(artistId: string): Promise<ArtistPage> {
    const client = await this.getMusicClient();
    const artistPage = await client.music.getArtist(artistId);
    const header = artistPage.header as unknown as {
      title?: { toString(): string };
      subtitle?: { toString(): string };
      description?: { toString(): string; runs?: Array<{ text?: string }> };
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      } | Array<{ url?: string; width?: number; height?: number }>;
      foreground_thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
    } | undefined;
    const responseItems = this.collectMusicItems(
      artistPage.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const headerText = [
      header?.subtitle?.toString(),
      header?.description?.toString(),
      ...(header?.description?.runs?.map((run) => run.text) ?? []),
    ].filter(Boolean).join(" ");
    const artistItem = responseItems.find((item) => item.item_type === "artist");
    const subscriberCount = headerText.match(/[\d,.]+\s*[KMB]?\s+subscribers?/i)?.[0]
      ?? artistItem?.subscribers;
    const headerThumbnail = Array.isArray(header?.thumbnail)
      ? header.thumbnail
      : header?.thumbnail?.contents;
    const artist: Artist = {
      id: artistId,
      name: header?.title?.toString()
        || artistItem?.title?.toString()
        || "Artist",
      artworkUrl: selectArtworkUrl(
        collectArtworkCandidates(
          headerThumbnail,
          header?.foreground_thumbnail,
          artistItem?.thumbnail,
        ),
      ),
      subscriberCount,
    };

    const popularSongs: Track[] = [];
    const releases: Album[] = [];
    const playlists: Playlist[] = [];
    for (const section of artistPage.sections as unknown as Array<{
      title?: { toString(): string };
      header?: { title?: { toString(): string } };
      contents?: MusicItem[];
    }>) {
      const sectionTitle = (
        section.title?.toString()
        || section.header?.title?.toString()
        || ""
      ).toLocaleLowerCase();
      const contents = section.contents ?? [];
      if (sectionTitle.includes("song")) {
        popularSongs.push(
          ...contents
            .map((item) => this.toTrack(item))
            .filter((item): item is Track => Boolean(item)),
        );
      }
      if (
        sectionTitle.includes("album")
        || sectionTitle.includes("single")
        || sectionTitle.includes("ep")
        || sectionTitle.includes("release")
      ) {
        releases.push(
          ...contents
            .flatMap((item): Album[] => {
              const album = this.toAlbum(item);
              if (!album) return [];
              const itemMetadata = (item.subtitle?.toString() ?? "").toLocaleLowerCase();
              const combinedSection = sectionTitle.includes("single")
                && sectionTitle.includes("ep");
              const metadata = itemMetadata || (combinedSection ? "" : sectionTitle);
              const releaseType: Album["releaseType"] = metadata.includes("ep")
                ? "ep"
                : metadata.includes("single")
                  ? "single"
                  : sectionTitle.includes("single")
                    ? "single"
                    : "album";
              return [{ ...album, releaseType }];
            }),
        );
      }
      if (sectionTitle.includes("playlist")) {
        playlists.push(
          ...contents
            .map((item) => this.toPlaylist(item))
            .filter((item): item is Playlist => Boolean(item)),
        );
      }
    }

    if (popularSongs.length === 0) {
      popularSongs.push(
        ...responseItems
          .filter((item) => item.item_type === "song" || item.item_type === "video")
          .map((item) => this.toTrack(item))
          .filter((item): item is Track => Boolean(item)),
      );
    }
    if (releases.length === 0) {
      releases.push(
        ...responseItems
          .filter((item) => item.item_type === "album")
          .map((item) => this.toAlbum(item))
          .filter((item): item is Album => Boolean(item))
          .map((album) => ({ ...album, releaseType: "album" as const })),
      );
    }
    if (playlists.length === 0) {
      playlists.push(
        ...responseItems
          .filter((item) => item.item_type === "playlist")
          .map((item) => this.toPlaylist(item))
          .filter((item): item is Playlist => Boolean(item)),
      );
    }

    let allSongShelf: Awaited<ReturnType<typeof artistPage.getAllSongs>>;
    try {
      allSongShelf = await artistPage.getAllSongs();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh all songs unavailable", {
        artistId,
        error: error instanceof Error ? error.message : String(error),
      });
      allSongShelf = undefined;
    }
    const allSongs = allSongShelf
      ? (allSongShelf.contents as unknown as MusicItem[])
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item))
      : popularSongs;

    const enrichedPopularSongs = await Promise.all(
      this.uniqueById(popularSongs).slice(0, 6).map(async (track) => {
        if (track.viewCount) return track;
        try {
          const info = await client.getBasicInfo(track.id);
          const basic = (info as {
            basic_info?: {
              view_count?: number;
            };
          }).basic_info;
          return basic?.view_count
            ? {
                ...track,
                viewCount: basic.view_count,
                viewCountText: `${basic.view_count} views`,
              }
            : track;
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh view count unavailable", {
            artistId,
            trackId: track.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return track;
        }
      }),
    );

    const subscriptionToggle = this.findArtistSubscriptionToggle(artistPage.page);
    const subscribed = this.getArtistSubscriptionOverride(artistId) ?? subscriptionToggle?.subscribed;

    return {
      artist,
      subscribed,
      popularSongs: enrichedPopularSongs,
      allSongs: this.uniqueById(allSongs),
      releases: this.uniqueById(releases),
      playlists: this.uniqueById(playlists),
    };
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshPlaylistTracks(playlist, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks background refresh failed", {
              playlistId: playlist.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks ignoring empty cache entry", {
        playlistId: playlist.id,
      });
    }

    return (await this.refreshPlaylistTracks(playlist, cacheKey)).value;
  }

  async getPlaylistTrackPage(
    playlist: Playlist,
    pageKey?: string,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage> {
    this.pruneExpiredPlaylistPageSessions();

    const cachedTracks = pageKey
      ? null
      : await getCachedJson<Track[]>(this.getPlaylistTrackCacheKey(playlist.id));
    if (cachedTracks?.length) {
      onUpdate?.({ tracks: cachedTracks, hasMore: false });
    }
    let page: YouTubeMusicPlaylistPage;
    let sessionKey = pageKey;
    let seenTrackIds = new Set<string>();
    let tracks: Track[] = [];

    if (pageKey) {
      const session = this.playlistPageSessions.get(pageKey);
      if (!session || session.playlistId !== playlist.id) {
        logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage missing session", {
          playlistId: playlist.id,
          pageKey,
        });
        return (await this.getCachedPlaylistFallback(playlist.id, null, onUpdate))
          ?? { tracks: [], hasMore: false };
      }

      if (!session.playlistPage.has_continuation) {
        this.playlistPageSessions.delete(pageKey);
        return { tracks: [], hasMore: false };
      }

      seenTrackIds = session.seenTrackIds;
      page = session.playlistPage;

      for (let attempts = 0; attempts < 100 && page.has_continuation && tracks.length === 0; attempts += 1) {
        try {
          page = await page.getContinuation();
        } catch (error) {
          this.playlistPageSessions.delete(pageKey);
          logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage continuation failed", {
            playlistId: playlist.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return (await this.getCachedPlaylistFallback(playlist.id, null, onUpdate))
            ?? { tracks: [], hasMore: false };
        }
        tracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
      }
    } else {
      let client: Innertube;
      try {
        client = await this.getMusicClient();
        page = await client.music.getPlaylist(playlist.id) as YouTubeMusicPlaylistPage;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage request failed", {
          playlistId: playlist.id,
          error: error instanceof Error ? error.message : String(error),
        });
        const fallback = await this.getCachedPlaylistFallback(playlist.id, cachedTracks, onUpdate);
        if (fallback) return fallback;
        throw error;
      }
      if (cachedTracks?.length) {
        seenTrackIds = new Set(cachedTracks.map((track) => track.id));
        const freshTracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
        tracks = freshTracks.length > 0
          ? await this.cachePlaylistTracks(playlist.id, freshTracks)
          : cachedTracks;
        seenTrackIds = new Set(tracks.map((track) => track.id));
      } else {
        tracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
      }

      if (!cachedTracks?.length && tracks.length === 0 && !page.has_continuation) {
        logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage verifying empty first page", {
          playlistId: playlist.id,
        });
        try {
          const fallbackTracks = await this.collectPlaylistTracksWithEmptyRetries(
            client,
            playlist.id,
            "paged-first-load",
          );
          if (fallbackTracks.length > 0) {
            const cachedFallbackTracks = await this.cachePlaylistTracks(playlist.id, fallbackTracks);
            return { tracks: cachedFallbackTracks, hasMore: false };
          }
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage empty-page verification failed", {
            playlistId: playlist.id,
            error: error instanceof Error ? error.message : String(error),
          });
          const fallback = await this.getCachedPlaylistFallback(playlist.id, cachedTracks, onUpdate);
          if (fallback) return fallback;
          throw error;
        }
      }
    }

    if (tracks.length > 0) {
      await this.cachePlaylistTracks(playlist.id, tracks);
    }

    if (!page.has_continuation) {
      if (sessionKey) this.playlistPageSessions.delete(sessionKey);
      logInternalInfo("YouTubeMusicDataSource.getPlaylistTrackPage complete", {
        playlistId: playlist.id,
        trackCount: tracks.length,
        hasMore: false,
      });
      return { tracks, hasMore: false };
    }

    sessionKey ??= this.createPlaylistPageKey(playlist.id);
    this.playlistPageSessions.set(sessionKey, {
      playlistId: playlist.id,
      playlistPage: page,
      seenTrackIds,
      expiresAt: Date.now() + PLAYLIST_PAGE_SESSION_TTL_MS,
    });

    logInternalInfo("YouTubeMusicDataSource.getPlaylistTrackPage loaded", {
      playlistId: playlist.id,
      trackCount: tracks.length,
      hasMore: true,
    });
    return { tracks, hasMore: true, nextPageKey: sessionKey };
  }

  private async refreshPlaylistTracks(
    playlist: Playlist,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.playlistRefreshPromises.get(playlist.id);
    if (!refresh) {
      refresh = this.fetchPlaylistTracksFresh(playlist).finally(() => {
        this.playlistRefreshPromises.delete(playlist.id);
      });
      this.playlistRefreshPromises.set(playlist.id, refresh);
    }

    try {
      const value = await refresh;
      const changed = value.length > 0
        ? await setCachedJson(cacheKey, value)
        : false;
      return { changed, value };
    } catch (error) {
      const fallback = await this.getCachedPlaylistFallback(playlist.id);
      if (fallback) {
        logInternalWarn("YouTubeMusicDataSource.refreshPlaylistTracks using cache after request failure", {
          playlistId: playlist.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { changed: false, value: fallback.tracks };
      }
      throw error;
    }
  }

  private async fetchPlaylistTracksFresh(playlist: Playlist): Promise<Track[]> {
    const client = await this.getMusicClient();
    return this.collectPlaylistTracksWithEmptyRetries(client, playlist.id, "fresh-load");
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (!this.signedIn) {
      throw new Error("Sign in to YouTube Music before adding songs to playlists.");
    }

    logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist start", {
      trackId: track.id,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      const existingTracks = cachedTracks
        ?? await this.collectPlaylistTracks(client, playlist.id);
      if (existingTracks.some((item) => item.id === track.id)) {
        if (!cachedTracks) await setCachedJson(cacheKey, existingTracks);
        logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist already present", {
          trackId: track.id,
          playlistId: playlist.id,
          source: cachedTracks ? "cache" : "network",
        });
        return "already-present";
      }

      const editablePlaylistId = playlist.id.startsWith("VL")
        ? playlist.id.slice(2)
        : playlist.id;
      await client.playlist.addVideos(editablePlaylistId, [track.id]);

      let confirmedTracks: Track[] | null = null;
      for (const delayMs of [0, 500, 1500]) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
        }

        const tracks = await this.collectPlaylistTracks(client, playlist.id);
        if (tracks.some((item) => item.id === track.id)) {
          confirmedTracks = tracks;
          break;
        }
      }

      if (!confirmedTracks) {
        throw new Error("YouTube Music did not confirm the playlist update.");
      }

      await setCachedJson(cacheKey, confirmedTracks);

      logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist success", {
        trackId: track.id,
        playlistId: playlist.id,
      });
      return "added";
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.addTrackToPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not add this song to the playlist.");
    }
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.signedIn) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    const client = await this.getMusicClient();
    const playlistId = playlist.id.startsWith("VL") ? playlist.id.slice(2) : playlist.id;
    try {
      const directResponse = await this.executePlaylistLibraryLikeCommand(client, playlistId, saved);
      if (directResponse.success === false) {
        throw new Error(`Playlist library update returned HTTP ${directResponse.status_code}.`);
      }
      logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved direct like command", {
        playlistId,
        saved,
      });
      return;
    } catch (directError) {
      logInternalWarn("YouTubeMusicDataSource.setPlaylistSaved direct like command failed", {
        playlistId,
        saved,
        error: directError instanceof Error ? directError.message : String(directError),
      });
    }

    try {
      const browseIds = [...new Set([playlist.id, playlistId, `VL${playlistId}`])];

      for (const browseId of browseIds) {
        let response: unknown;
        try {
          response = await this.executeMusicBrowse(client, { browseId });
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.setPlaylistSaved browse failed", {
            playlistId,
            browseId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const rawToggle = this.findRawLibraryToggle(response);
        if (!rawToggle) continue;

        if (rawToggle.isToggled === saved) return;
        const endpoint = saved
          ? rawToggle.defaultServiceEndpoint
          : rawToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library command for this playlist.");
        }

        logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved raw command", {
          playlistId,
          browseId,
          saved,
          iconType: rawToggle.defaultIcon?.iconType,
          defaultTooltip: rawToggle.defaultTooltip,
          toggledTooltip: rawToggle.toggledTooltip,
        });

        const updateResponse = await this.executeRawServiceEndpoint(client, endpoint);
        if (updateResponse.success === false) {
          throw new Error(`Playlist library update returned HTTP ${updateResponse.status_code}.`);
        }
        return;
      }

      const playlistPage = await client.music.getPlaylist(playlistId);
      const toggle = this.findLibraryToggleEndpoint(playlistPage.page);
      if (!toggle) {
        throw new Error("YouTube Music did not return a library command for this playlist.");
      }
      if (toggle.isToggled === saved) return;

      const endpoint = saved ? toggle.endpoint : toggle.toggledEndpoint;
      if (!endpoint) {
        throw new Error("YouTube Music returned an incomplete library command for this playlist.");
      }

      logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved command", {
        playlistId,
        saved,
        iconType: toggle.iconType,
        tooltip: toggle.tooltip,
        toggledTooltip: toggle.toggledTooltip,
      });

      const response = await endpoint.call(client.actions, { client: "YTMUSIC" });
      if (response.success === false) {
        throw new Error(`Playlist library update returned HTTP ${response.status_code}.`);
      }
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setPlaylistSaved failed", error, {
        playlistId,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this playlist."
          : "YouTube Music could not remove this playlist.",
      );
    }
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    if (!this.signedIn) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    if (!track.playlistItemId) {
      throw new Error("Reload the playlist before removing this song.");
    }

    logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist start", {
      trackId: track.id,
      playlistItemId: track.playlistItemId,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
      const editablePlaylistId = playlist.id.startsWith("VL")
        ? playlist.id.slice(2)
        : playlist.id;

      const response = await client.actions.execute("browse/edit_playlist", {
        playlistId: editablePlaylistId,
        actions: [
          {
            action: "ACTION_REMOVE_VIDEO",
            setVideoId: track.playlistItemId,
          },
        ],
      });
      if (!response.success) {
        throw new Error(`Playlist edit returned HTTP ${response.status_code}.`);
      }

      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      if (cachedTracks) {
        await setCachedJson(
          cacheKey,
          cachedTracks.filter((item) => item.playlistItemId !== track.playlistItemId),
        );
      }

      logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist success", {
        trackId: track.id,
        playlistItemId: track.playlistItemId,
        playlistId: playlist.id,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.removeTrackFromPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not remove this song from the playlist.");
    }
  }

  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    if (!this.signedIn) {
      throw new Error("Sign in to like songs.");
    }

    logInternalInfo("YouTubeMusicDataSource.setTrackLiked start", {
      trackId: track.id,
      liked,
    });

    try {
      const client = await this.getMusicClient();
      const response = await this.executeTrackLikeCommand(client, track.id, liked);

      if (!response.success) {
        throw new Error(`YouTube returned HTTP ${response.status_code}.`);
      }

      const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
      if (cachedLibrary) {
        const likedSongs = liked
          ? this.uniqueById([track, ...cachedLibrary.likedSongs])
          : cachedLibrary.likedSongs.filter((item) => item.id !== track.id);
        await setCachedJson(LIBRARY_CACHE_KEY, {
          ...cachedLibrary,
          likedSongs,
        });
      }
      const likedSongsCacheKey = this.getPlaylistTrackCacheKey(LIKED_SONGS_PLAYLIST_ID);
      const cachedLikedSongs = await getCachedJson<Track[]>(likedSongsCacheKey);
      if (liked) {
        await this.cachePlaylistTracks(LIKED_SONGS_PLAYLIST_ID, [track]);
      } else if (cachedLikedSongs) {
        await setCachedJson(
          likedSongsCacheKey,
          cachedLikedSongs.filter((item) => item.id !== track.id),
        );
      }

      logInternalInfo("YouTubeMusicDataSource.setTrackLiked success", {
        trackId: track.id,
        liked,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setTrackLiked failed", error, {
        trackId: track.id,
        liked,
      });
      throw new Error(liked
        ? "YouTube Music could not like this song."
        : "YouTube Music could not remove this like.");
    }
  }

  async getTrack(id: string): Promise<Track> {
    const trackId = id;
    if (!trackId) throw new Error("A track id is required.");
    const cacheKey = `youtube-music:track:v1:${trackId}`;
    const cached = await getCachedJson<Track>(cacheKey);

    if (cached?.artworkUrl) {
      globalThis.setTimeout(() => {
        void this.refreshTrack(trackId, cacheKey).catch((error) => {
          logInternalWarn("YouTubeMusicDataSource.getTrack background refresh failed", {
            trackId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
      return cached;
    }

    if (cached) {
      try {
        return await this.refreshTrack(trackId, cacheKey);
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getTrack missing-artwork refresh failed", {
          trackId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cached;
      }
    }

    try {
      return await this.refreshTrack(trackId, cacheKey);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getTrack failed", error, { trackId });
      return {
        id: trackId,
        source: "youtube",
        title: `Track (${trackId})`,
        artist: "Unknown artist",
      };
    }
  }

  async getLyrics(track: Track): Promise<Lyrics | null> {
    const cacheKey = `lyrics:synced:v2:${track.id}`;
    const cached = await getCachedJson<Lyrics>(cacheKey);
    if (cached?.timing === "synced" && cached.lines.length > 0) return cached;

    let refresh = this.lyricsRefreshPromises.get(track.id);
    if (!refresh) {
      refresh = this.fetchSyncedLyrics(track).finally(() => {
        this.lyricsRefreshPromises.delete(track.id);
      });
      this.lyricsRefreshPromises.set(track.id, refresh);
    }

    const lyrics = await refresh;
    if (lyrics) await setCachedJson(cacheKey, lyrics);
    return lyrics;
  }

  private async fetchSyncedLyrics(track: Track): Promise<Lyrics | null> {
    logInternalInfo("YouTubeMusicDataSource.getLyrics start", { trackId: track.id });
    const providerLyrics = await this.fetchProviderLyrics(track);
    if (providerLyrics) return providerLyrics;

    try {
      const webClient = await this.getWebClient();
      const info = await webClient.getInfo(track.id);
      const transcript = await info.getTranscript();
      const segments = transcript.transcript.content?.body?.initial_segments ?? [];
      const timedLines = segments.flatMap((segment) => {
        const item = segment as unknown as {
          start_ms?: string;
          end_ms?: string;
          snippet?: { toString(): string };
        };
        const text = item.snippet?.toString().trim();
        const startTimeMs = Number(item.start_ms);
        const endTimeMs = Number(item.end_ms);
        if (!text || !Number.isFinite(startTimeMs)) return [];

        return [{
          text,
          startTimeSec: startTimeMs / 1000,
          endTimeSec: Number.isFinite(endTimeMs) ? endTimeMs / 1000 : undefined,
        }];
      });

      if (timedLines.length > 0) {
        logInternalInfo("YouTubeMusicDataSource.getLyrics timed transcript success", {
          trackId: track.id,
          lineCount: timedLines.length,
        });
        return {
          lines: timedLines,
          timing: "synced",
          sourceLabel: "YouTube",
        };
      }
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getLyrics timed transcript unavailable", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  private async fetchProviderLyrics(track: Track): Promise<Lyrics | null> {
    const attempts: Array<Promise<LyricsProviderResult | null>> = [
      this.withTimeout(
        this.fetchLrcLibExactLyrics(track),
        2_500,
        "LRCLIB exact",
        track.id,
      ),
      this.withTimeout(
        this.fetchBetterLyrics(track),
        3_500,
        "BetterLyrics",
        track.id,
      ),
      this.withTimeout(
        this.fetchLrcLibSearchLyrics(track),
        4_500,
        "LRCLIB search",
        track.id,
      ),
    ];

    for (const attempt of attempts) {
      const result = await attempt;
      if (result) {
        const { priority: _priority, ...lyrics } = result;
        return lyrics;
      }
    }

    return null;
  }

  private async fetchLrcLibExactLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = this.getRoundedDurationSec(track);
    if (!durationSec) return null;

    for (const query of this.getLyricsQueries(track)) {
      const params = new URLSearchParams({
        track_name: query.title,
        artist_name: query.artist,
        duration: String(durationSec),
      });
      if (query.album) params.set("album_name", query.album);

      try {
        const response = await tauriFetch(`https://lrclib.net/api/get?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 2_500,
        });
        if (!response.ok) continue;

        const match = await response.json() as LrcLibTrack;
        const result = this.toLrcLibLyrics(track, match, "LRCLIB", 0);
        if (result) return result;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics LRCLIB exact unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private async fetchLrcLibSearchLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return null;

    for (const query of this.getLyricsQueries(track)) {
      try {
        const params = new URLSearchParams({
          track_name: query.title,
          artist_name: query.artist,
        });
        if (query.album) params.set("album_name", query.album);

        const response = await tauriFetch(`https://lrclib.net/api/search?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 4_500,
        });
        if (!response.ok) continue;

        const matches = await response.json() as LrcLibTrack[];
        const candidates = matches
          .map((match) => ({
            match,
            durationDelta: this.getLyricsDurationDelta(track, match.duration),
          }))
          .filter(({ match, durationDelta }) => Boolean(match.syncedLyrics) && durationDelta <= 2)
          .sort((left, right) => left.durationDelta - right.durationDelta);

        for (const candidate of candidates) {
          const result = this.toLrcLibLyrics(track, candidate.match, "LRCLIB", 2);
          if (result) return result;
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics LRCLIB search unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private async fetchBetterLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = this.getRoundedDurationSec(track);

    for (const query of this.getLyricsQueries(track)) {
      const params = new URLSearchParams({
        s: query.title,
        a: query.artist,
      });
      if (durationSec) params.set("d", String(durationSec));
      if (query.album) params.set("al", query.album);

      try {
        const response = await tauriFetch(`https://lyrics-api.boidu.dev/getLyrics?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 3_500,
        });
        if (!response.ok) continue;

        const body = await response.json() as BetterLyricsResponse;
        if (!body.ttml) continue;

        const lines = this.parseTtmlLyrics(body.ttml);
        if (lines.length === 0) continue;

        logInternalInfo("YouTubeMusicDataSource.getLyrics BetterLyrics success", {
          trackId: track.id,
          lineCount: lines.length,
        });
        return {
          lines,
          timing: "synced",
          sourceLabel: "BetterLyrics",
          priority: 1,
        };
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics BetterLyrics unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private toLrcLibLyrics(
    track: Track,
    match: LrcLibTrack,
    sourceLabel: string,
    priority: number,
  ): LyricsProviderResult | null {
    if (!match.syncedLyrics) return null;
    const durationDelta = this.getLyricsDurationDelta(track, match.duration);
    if (durationDelta > 2) return null;

    const lines = this.parseSyncedLyrics(match.syncedLyrics);
    if (lines.length === 0) return null;

    logInternalInfo("YouTubeMusicDataSource.getLyrics LRCLIB success", {
      trackId: track.id,
      lineCount: lines.length,
      durationDelta,
      sourceLabel,
    });
    return {
      lines,
      timing: "synced",
      sourceLabel,
      priority,
    };
  }

  private getLyricsRequestHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "User-Agent": "OpenDeck/1.0.0",
    };
  }

  private getRoundedDurationSec(track: Track): number | null {
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return null;
    return Math.round(durationSec);
  }

  private getLyricsDurationDelta(track: Track, providerDuration: number | undefined): number {
    if (typeof providerDuration !== "number") return Number.POSITIVE_INFINITY;
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(providerDuration - durationSec);
  }

  private getLyricsQueries(track: Track): Array<{ title: string; artist: string; album?: string }> {
    const artists = [
      track.artist,
      ...(track.artists?.map((artist) => artist.name) ?? []),
    ];
    const titles = [
      track.title,
      this.cleanLyricsLookupText(track.title),
    ];
    const albums = [
      track.album,
      track.album ? this.cleanLyricsLookupText(track.album) : undefined,
    ];
    const queries: Array<{ title: string; artist: string; album?: string }> = [];
    const seen = new Set<string>();

    for (const title of titles) {
      if (!title) continue;
      for (const artist of artists) {
        if (!artist || artist === "Unknown artist") continue;
        const cleanedArtist = this.cleanLyricsLookupText(artist);
        for (const artistName of [artist, cleanedArtist]) {
          if (!artistName) continue;
          const album = albums.find((value) => value && value !== "Unknown album");
          const key = `${title}\n${artistName}\n${album ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queries.push({ title, artist: artistName, album });
        }
      }
    }

    return queries.length > 0
      ? queries.slice(0, 6)
      : [{ title: track.title, artist: track.artist, album: track.album }];
  }

  private cleanLyricsLookupText(value: string): string {
    return value
      .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|visualizer|audio|lyrics?|lyric\s*video|remaster(?:ed)?|radio edit|single version|album version|live|feat\.?|ft\.?)[^\])]*[\])]\s*/gi, " ")
      .replace(/\s+-\s+(?:official\s*)?(?:music\s*)?(?:video|visualizer|audio|lyrics?|lyric\s*video).*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private async withTimeout(
    promise: Promise<LyricsProviderResult | null>,
    timeoutMs: number,
    provider: string,
    trackId: string,
  ): Promise<LyricsProviderResult | null> {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutId = globalThis.setTimeout(() => {
        logInternalWarn("YouTubeMusicDataSource.getLyrics provider timed out", {
          trackId,
          provider,
          timeoutMs,
        });
        resolve(null);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    }
  }

  private parseSyncedLyrics(lrc: string): Lyrics["lines"] {
    const lines: Lyrics["lines"] = [];
    const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const rawLine of lrc.split(/\r?\n/)) {
      const text = rawLine.replace(timestampPattern, "").trim();
      if (!text) continue;

      const timestamps = [...rawLine.matchAll(timestampPattern)];
      for (const timestamp of timestamps) {
        const minutes = Number(timestamp[1]);
        const seconds = Number(timestamp[2]);
        const fraction = timestamp[3] ?? "0";
        const fractionSec = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
        lines.push({
          text,
          startTimeSec: minutes * 60 + seconds + fractionSec,
        });
      }
    }

    lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
    return lines.map((line, index) => ({
      ...line,
      endTimeSec: lines[index + 1]?.startTimeSec,
    }));
  }

  private parseTtmlLyrics(ttml: string): Lyrics["lines"] {
    const parser = new DOMParser();
    const document = parser.parseFromString(ttml, "application/xml");
    if (document.querySelector("parsererror")) return [];

    const lines = [...document.getElementsByTagName("p")].flatMap((node) => {
      const startTimeSec = this.parseTtmlTime(node.getAttribute("begin") ?? node.getAttribute("start"));
      if (startTimeSec === undefined) return [];

      const endTimeSec = this.parseTtmlTime(node.getAttribute("end"));
      const text = (node.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return [];

      return [{
        text,
        startTimeSec,
        endTimeSec,
      }];
    });

    lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
    return lines.map((line, index) => ({
      ...line,
      endTimeSec: line.endTimeSec ?? lines[index + 1]?.startTimeSec,
    }));
  }

  private parseTtmlTime(value: string | null): number | undefined {
    if (!value) return undefined;

    const clockTime = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (clockTime) {
      const hours = Number(clockTime[1]);
      const minutes = Number(clockTime[2]);
      const seconds = Number(clockTime[3]);
      const fraction = clockTime[4] ?? "0";
      return hours * 3600 + minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
    }

    const minuteTime = value.match(/^(\d+):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (minuteTime) {
      const minutes = Number(minuteTime[1]);
      const seconds = Number(minuteTime[2]);
      const fraction = minuteTime[3] ?? "0";
      return minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
    }

    const offsetTime = value.match(/^([\d.]+)(h|m|s|ms)$/);
    if (offsetTime) {
      const amount = Number(offsetTime[1]);
      if (!Number.isFinite(amount)) return undefined;
      if (offsetTime[2] === "h") return amount * 3600;
      if (offsetTime[2] === "m") return amount * 60;
      if (offsetTime[2] === "s") return amount;
      return amount / 1000;
    }

    return undefined;
  }

  private async refreshTrack(trackId: string, cacheKey: string): Promise<Track> {
    let refresh = this.trackRefreshPromises.get(trackId);
    if (!refresh) {
      refresh = this.fetchTrackFresh(trackId).finally(() => {
        this.trackRefreshPromises.delete(trackId);
      });
      this.trackRefreshPromises.set(trackId, refresh);
    }

    const track = await refresh;
    await setCachedJson(cacheKey, track);
    return track;
  }

  private async fetchTrackFresh(trackId: string): Promise<Track> {
    logInternalInfo("YouTubeMusicDataSource.getTrack start", { trackId });
    const yt = await this.getMusicClient();
    const info = await yt.getBasicInfo(trackId);
    const basic = (info as any).basic_info;
    const artwork = selectArtworkUrl(basic?.thumbnail);
    const track: Track = {
      id: basic?.id ?? trackId,
      source: "youtube",
      title: basic?.title ?? `Track (${trackId})`,
      artist: basic?.author ?? "Unknown artist",
      artists: basic?.channel_id && basic?.author
        ? [{ id: basic.channel_id, name: basic.author }]
        : undefined,
      durationSec: basic?.duration,
      artworkUrl: artwork,
    };

    logInternalInfo("YouTubeMusicDataSource.getTrack success", {
      trackId: track.id,
      title: track.title,
    });
    return track;
  }

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { artists: [], tracks: [], albums: [], playlists: [] };
    }
    const cacheId = normalizedQuery.toLocaleLowerCase();
    const cacheKey = `youtube-music:mixed-search:v5:${cacheId}`;
    const cached = await getCachedJson<SearchResults>(cacheKey);
    if (cached && this.hasSearchResults(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.search background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshMixedSearch(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: SearchResults }> {
    let refresh = this.mixedSearchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchMixedSearchFresh(query).finally(() => {
        this.mixedSearchRefreshPromises.delete(cacheId);
      });
      this.mixedSearchRefreshPromises.set(cacheId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async fetchMixedSearchFresh(query: string): Promise<SearchResults> {
    const client = await this.getMusicClient();
    const [response, artistResponse] = await Promise.all([
      client.music.search(query),
      client.music.search(query, { type: "artist" }).catch(() => null),
    ]);
    const fromShelf = <T>(
      shelf: { contents?: unknown[] } | undefined,
      mapper: (item: MusicItem) => T | null,
    ): T[] => (shelf?.contents ?? [])
      .map((item) => mapper(item as MusicItem))
      .filter((item): item is T => Boolean(item));

    const libraryPlaylistIds = new Set(
      this.libraryRefreshPromise
        ? []
        : (await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY))?.playlists.map(
          (playlist) => playlist.id.replace(/^VL/, ""),
        ) ?? [],
    );
    const fallbackItems = this.collectMusicItems(
      response.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const artistFallbackItems = artistResponse
      ? this.collectMusicItems(artistResponse.page, new Set(["artist"]))
      : [];
    const artistCardItems = [
      ...this.collectArtistCardItems(response.page),
      ...(artistResponse ? this.collectArtistCardItems(artistResponse.page) : []),
    ];
    const shelfArtists = fromShelf(response.artists, (item) => this.toArtist(item));
    const shelfTracks = fromShelf(response.songs, (item) => this.toTrack(item));
    const shelfAlbums = fromShelf(response.albums, (item) => this.toAlbum(item));
    const shelfPlaylists = fromShelf(response.playlists, (item) => this.toPlaylist(item));
    const playlists = [
      ...shelfPlaylists,
      ...fallbackItems
        .filter((item) => item.item_type === "playlist")
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item)),
    ]
      .map((playlist) => ({
        ...playlist,
        isSaved: libraryPlaylistIds.has(playlist.id.replace(/^VL/, "")),
      }));

    const tracks = this.uniqueById([
      ...shelfTracks,
      ...fallbackItems
        .filter((item) => item.item_type === "song" || item.item_type === "video")
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item)),
    ]);
    const albums = this.uniqueById([
      ...shelfAlbums,
      ...fallbackItems
        .filter((item) => item.item_type === "album")
        .map((item) => this.toAlbum(item))
        .filter((item): item is Album => Boolean(item)),
    ]);

    const artists = await this.hydrateArtistArtwork(this.uniqueById([
      ...shelfArtists,
      ...fromShelf(artistResponse?.artists, (item) => this.toArtist(item)),
      ...fallbackItems
        .filter((item) => item.item_type === "artist")
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...artistFallbackItems
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...artistCardItems
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...this.artistsFromReferences([...tracks, ...albums], query),
    ]));

    const results = {
      artists,
      tracks,
      albums,
      playlists: this.uniqueById(playlists),
    };
    if (this.hasSearchResults(results)) return results;

    const fallbackTracks = await this.fetchSearchTracksFresh(query);
    return { artists: [], tracks: fallbackTracks, albums: [], playlists: [] };
  }

  private hasSearchResults(results: SearchResults): boolean {
    return results.artists.length > 0
      || results.tracks.length > 0
      || results.albums.length > 0
      || results.playlists.length > 0;
  }

  async searchTracks(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search:v1:${cacheId}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.searchTracks background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    return (await this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshSearchTracks(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.searchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchTracksFresh(query).finally(() => {
        this.searchRefreshPromises.delete(cacheId);
      });
      this.searchRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchTracksFresh(normalizedQuery: string): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.searchTracks start", {
      query: normalizedQuery,
    });

    try {
      const client = await this.getMusicClient();
      const response = await client.music.search(normalizedQuery, { type: "song" });
      const tracks = this.uniqueById(
        (response.songs?.contents ?? [])
        .map((item) => this.toTrack(item as unknown as MusicItem))
          .filter((item): item is Track => Boolean(item)),
      );

      logInternalInfo("YouTubeMusicDataSource.searchTracks success", {
        query: normalizedQuery,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.searchTracks failed", error, {
        query: normalizedQuery,
      });
      throw new Error("Unable to search for songs.");
    }
  }

  async getSearchSuggestions(
    query: string,
    onUpdate?: (suggestions: string[]) => void,
  ): Promise<string[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search-suggestions:v1:${cacheId}`;
    const cached = await getCachedJson<string[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshSearchSuggestions(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: string[] }> {
    let refresh = this.suggestionRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchSuggestionsFresh(query).finally(() => {
        this.suggestionRefreshPromises.delete(cacheId);
      });
      this.suggestionRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchSuggestionsFresh(normalizedQuery: string): Promise<string[]> {
    try {
      const client = await this.getMusicClient();
      const sections = await client.music.getSearchSuggestions(normalizedQuery);
      const suggestions = sections.flatMap((section) =>
        section.contents
          .map((item) => {
            const suggestion = item as {
              suggestion?: { toString(): string };
            };
            return suggestion.suggestion?.toString() ?? "";
          })
          .filter(Boolean)
      );

      return [...new Set(suggestions)].slice(0, 3);
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions failed", {
        query: normalizedQuery,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("Unable to load search suggestions.");
    }
  }

  async getRecommendations(
    seed: Track,
    onUpdate?: (tracks: Track[]) => void,
  ): Promise<Track[]> {
    const cacheKey = `youtube-music:recommendations:v1:${seed.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshRecommendations(seed, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getRecommendations background refresh failed", {
              seedTrackId: seed.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshRecommendations(seed, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshRecommendations(
    seed: Track,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.recommendationRefreshPromises.get(seed.id);
    if (!refresh) {
      refresh = this.fetchRecommendationsFresh(seed).finally(() => {
        this.recommendationRefreshPromises.delete(seed.id);
      });
      this.recommendationRefreshPromises.set(seed.id, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchRecommendationsFresh(seed: Track): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.getRecommendations start", {
      seedTrackId: seed.id,
    });

    try {
      const client = await this.getMusicClient();
      const panel = await client.music.getUpNext(seed.id, true);
      const recommendationTracks: Track[] = [];
      for (const entry of panel.contents) {
        const item = entry as unknown as UpNextItem;
        const video = item.primary ?? item;
        const id = video.video_id;
        const title = video.title?.toString();
        if (!id || !title || id === seed.id) continue;

        recommendationTracks.push({
          id,
          source: "youtube",
          title,
          artist: video.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
            || video.author
            || "Unknown artist",
          artists: video.artists
            ?.map((artist) => ({
              id: artist.channel_id
                ?? this.findBrowseId(artist.endpoint)
                ?? this.findBrowseId(artist.navigationEndpoint)
                ?? "",
              name: artist.name ?? "",
            }))
            .filter((artist) => artist.name),
          durationSec: video.duration?.seconds,
          artworkUrl: selectArtworkUrl(video.thumbnail) ?? getVideoArtworkFallback(id),
        });
      }
      const tracks = this.uniqueById(recommendationTracks);

      logInternalInfo("YouTubeMusicDataSource.getRecommendations success", {
        seedTrackId: seed.id,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getRecommendations failed", error, {
        seedTrackId: seed.id,
      });
      throw new Error("Unable to load recommendations.");
    }
  }

  async getStreamUrl(track: Track): Promise<string> {
    logInternalInfo("YouTubeMusicDataSource.getStreamUrl start", { trackId: track.id });
    const { url } = await this.resolveStreamUrl(track);
    return url;
  }

  private async resolveStream(
    track: Track,
    quality: AudioQuality,
    clientOrder: readonly ClientLabel[],
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    let streamUrl: string | null = null;
    let streamMimeType = "audio/mp4";
    const failures: string[] = [];

    // Mint the po-token once per track and attach it to every client that
    // attempts playback. YouTube withholds streaming URLs entirely (empty
    // `url` on all formats) for requests without a valid, video-bound
    // attestation — on every InnerTube client, not just the web ones.
    const poToken = await mintPoToken(track.id);

    for (const label of clientOrder) {
      try {
        const yt = await this.getClient(label);
        if (poToken) {
          yt.session.po_token = poToken;
          if (yt.session.player) yt.session.player.po_token = poToken;
        }
        const info = await yt.getBasicInfo(track.id, poToken ? { po_token: poToken } : undefined);
        const urlLessFormats = (info.streaming_data?.adaptive_formats ?? []).length;
        if (urlLessFormats > 0 && !info.streaming_data?.adaptive_formats?.some(
          (candidate: any) => (typeof candidate.url === "string" && candidate.url.length > 0)
            || typeof candidate.signature_cipher === "string"
            || typeof candidate.cipher === "string",
        )) {
          // YouTube withholds both plain and ciphered URLs when it rejects
          // the request's attestation — formats arrive metadata-only.
          throw new Error(
            "YouTube returned metadata-only formats (attestation not accepted for this client).",
          );
        }
        const audioFormats = (info.streaming_data?.adaptive_formats ?? []).filter(
          (candidate: any) => typeof candidate.mime_type === "string"
            && candidate.mime_type.startsWith("audio/"),
        );
        const mp4Formats = audioFormats.filter(
          (candidate: any) => candidate.mime_type.includes("audio/mp4"),
        );
        const candidates = quality === "high" || mp4Formats.length === 0
          ? audioFormats
          : mp4Formats;
        const format = selectFormatForQuality(candidates as Array<{ bitrate?: number }>, quality) as
          | (typeof candidates)[number]
          | undefined;
        if (!format) {
          const offered = (info.streaming_data?.adaptive_formats ?? [])
            .map((candidate: any) => candidate.mime_type)
            .filter(Boolean)
            .slice(0, 8);
          throw new Error(
            `YouTube returned no playable audio format. Offered: ${offered.join(", ") || "none"}`,
          );
        }

        streamUrl = this.withSessionClientVersion(await format.decipher(yt.session.player), yt);
        if (!streamUrl) {
          throw new Error("YouTube returned an empty audio URL.");
        }

        streamMimeType = (format as any).mime_type ?? "audio/mp4";
        logInternalInfo("YouTubeMusicDataSource.resolveStream format selected", {
          trackId: track.id,
          client: label,
          quality,
          itag: (format as any).itag ?? null,
          mimeType: streamMimeType,
          bitrate: (format as any).bitrate ?? null,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${message}`);
        logInternalWarn("YouTubeMusicDataSource.resolveStream client failed", {
          trackId: track.id,
          client: label,
          error: message,
        });
      }
    }

    if (!streamUrl) {
      logInternalError(
        "YouTubeMusicDataSource.resolveStream failed",
        new Error("No YouTube client returned a playable audio URL."),
        { trackId: track.id, failures },
      );
      throw new Error(
        `Unable to resolve a playable YouTube audio stream. (${failures.slice(-2).join("; ")})`,
      );
    }

    return {
      url: streamUrl,
      mimeType: streamMimeType,
      cookie: undefined,
    };
  }

  async resolveStreamUrl(
    track: Track,
    quality: AudioQuality = getStreamingQuality(),
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    // The attested web clients run first — they are the proven path when
    // BotGuard attestation succeeds (the mobile clients then cost nothing).
    // ANDROID/IOS rescue playback when YouTube refuses the web clients;
    // linked accounts keep the music client in front so authenticated
    // playback/reporting wins when YouTube honors it.
    const order: ClientLabel[] = usesAuthenticatedStreaming()
      ? ["music", "web", "android", "ios", "anonymous"]
      : ["anonymous", "web", "music", "android", "ios"];
    return this.resolveStream(track, quality, order);
  }

  async resolveDownloadStream(
    track: Track,
    quality: AudioQuality = "normal",
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    if (track.source !== "youtube") {
      throw new Error("Only YouTube tracks can be downloaded.");
    }

    // Downloads should not be governed by the playback engine preference. Try the authenticated
    // download client first, then fall back through the same clients used for playback.
    return this.resolveStream(track, quality, ["download", "music", "web", "anonymous", "android", "ios"]);
  }

  async beginPlayReport(track: Track): Promise<boolean> {
    this.playReport = null;
    const scrobblingEnabled = usesYouTubeScrobbling();
    if (!scrobblingEnabled || track.source !== "youtube" || !this.signedIn) {
      logInternalInfo("YouTubeMusicDataSource.beginPlayReport skipped", {
        trackId: track.id,
        scrobblingEnabled,
        trackSource: track.source,
        signedIn: this.signedIn,
      });
      return false;
    }

    try {
      const yt = await this.getMusicClient();
      const raw = await yt.actions.execute("/player", {
        videoId: track.id,
        racyCheckOk: true,
        contentCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            vis: 0,
            splay: false,
            lactMilliseconds: "-1",
            signatureTimestamp: (yt.session as { player?: { signature_timestamp?: number } })
              .player?.signature_timestamp,
          },
        },
        parse: false,
      });
      const tracking = (raw as any)?.data?.playbackTracking ?? (raw as any)?.playbackTracking;
      const playbackUrl = tracking?.videostatsPlaybackUrl?.baseUrl;
      const watchtimeUrl = tracking?.videostatsWatchtimeUrl?.baseUrl;
      logInternalInfo("YouTubeMusicDataSource.beginPlayReport tracking urls", {
        trackId: track.id,
        hasPlaybackUrl: Boolean(playbackUrl),
        hasWatchtimeUrl: Boolean(watchtimeUrl),
        hasAtrUrl: Boolean(tracking?.atrUrl?.baseUrl),
        hasQoeUrl: Boolean(tracking?.videostatsDelayplayUrl?.baseUrl),
        playback: playbackUrl ? summarizePlaybackStatsUrl(playbackUrl) : null,
        watchtime: watchtimeUrl ? summarizePlaybackStatsUrl(watchtimeUrl) : null,
      });
      if (!playbackUrl || !watchtimeUrl) {
        logInternalWarn("YouTubeMusicDataSource.beginPlayReport no tracking urls", {
          trackId: track.id,
        });
        return false;
      }

      const cpn = createPlaybackNonce();
      this.playReport = {
        trackId: track.id,
        cpn,
        playbackUrl,
        watchtimeUrl,
        startedAt: Date.now(),
        lastReportedSec: 0,
      };
      await this.pingPlaybackStats(playbackUrl, {
        cpn,
        rtn: "0",
      });
      logInternalInfo("YouTubeMusicDataSource.beginPlayReport started", { trackId: track.id });
      return true;
    } catch (error) {
      this.playReport = null;
      logInternalWarn("YouTubeMusicDataSource.beginPlayReport failed", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async updatePlayReport(track: Track, positionSec: number, final: boolean): Promise<void> {
    const report = this.playReport;
    if (!report || report.trackId !== track.id) {
      logInternalDebug("YouTubeMusicDataSource.updatePlayReport skipped", {
        trackId: track.id,
        reportTrackId: report?.trackId ?? null,
        hasReport: Boolean(report),
        positionSec,
        final,
      });
      return;
    }
    if (final) this.playReport = null;

    const wallElapsed = Math.floor((Date.now() - report.startedAt) / 1000);
    const watched = Math.max(0, Math.min(Math.floor(positionSec), wallElapsed));
    if (watched <= report.lastReportedSec) {
      logInternalDebug("YouTubeMusicDataSource.updatePlayReport no progress", {
        trackId: track.id,
        positionSec,
        watched,
        lastReportedSec: report.lastReportedSec,
        wallElapsed,
        final,
      });
      return;
    }

    try {
      await this.pingPlaybackStats(report.watchtimeUrl, {
        cpn: report.cpn,
        st: "0",
        et: String(watched),
        cmt: String(watched),
        state: final ? "paused" : "playing",
        ...(final ? { final: "1" } : {}),
      });
      report.lastReportedSec = watched;
      logInternalDebug("YouTubeMusicDataSource.updatePlayReport", {
        trackId: track.id,
        watched,
        wallElapsed,
        final,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.updatePlayReport failed", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async pingPlaybackStats(
    baseUrl: string,
    params: Record<string, string>,
  ): Promise<void> {
    const client = await this.getMusicClient();
    const clientVersion = client.session.context.client.clientVersion;
    const url = new URL(baseUrl);
    const endpoint = url.pathname;
    const query = {
      ver: "2",
      fmt: "251",
      rt: "0",
      c: "WEB_REMIX",
      cver: clientVersion,
      ...params,
    };
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    logInternalInfo("YouTubeMusicDataSource.pingPlaybackStats request", {
      endpoint,
      params,
      querySummary: summarizePlaybackStatsUrl(url.toString()),
      hasCookie: false,
      signedIn: this.signedIn,
      accountIndex: this.musicAccountIndex,
      hasOnBehalfOfUser: Boolean(this.musicOnBehalfOfUser),
      hasSerializedDelegationContext: Boolean(this.musicSerializedDelegationContext),
      clientVersion,
    });
    const response = await tauriFetch(url.toString(), {
      headers: {
        "x-youtube-client-name": "67",
        "x-youtube-client-version": clientVersion,
        "x-goog-authuser": this.musicAccountIndex.toString(),
      },
    });
    logInternalInfo("YouTubeMusicDataSource.pingPlaybackStats response", {
      endpoint,
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) {
      throw new Error(`YouTube playback stats returned HTTP ${response.status}.`);
    }
  }

  async getStreamData(track: Track): Promise<StreamData> {
    if (track.source === "local") {
      if (!track.localPath) {
        throw new Error("Local track path is missing.");
      }
      const payload = await readLocalAudio(track.localPath);
      if (!payload) {
        throw new Error(
          "Local audio file is not accessible. Re-select your music folder in Settings → Local files.",
        );
      }
      return { bytes: payload.bytes, mimeType: payload.mimeType };
    }

    const { url: streamUrl, mimeType: streamMimeType } = await this.resolveStreamUrl(track);
    logInternalInfo("YouTubeMusicDataSource.getStreamData stream resolved", {
      trackId: track.id,
      mimeType: streamMimeType,
    });
    return {
      mimeType: streamMimeType,
      sourceUrl: buildMediaStreamUrl(streamUrl, {
        videoId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artworkUrl,
        durationSec: track.durationSec,
      }),
    };
  }
}

import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  IconChevronDown,
  IconCopy,
  IconFolder,
  IconFolderPlus,
  IconFolderOpen,
  IconKey,
  IconLogin,
  IconLogout,
  IconPalette,
  IconRefresh,
  IconShieldExclamation,
  IconEyeOff,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import {
  clearCache,
  DEFAULT_ARTWORK_CACHE_SIZE_MB,
  DEFAULT_CACHE_SIZE_GB,
  formatArtworkCache,
  getArtworkCacheStats,
  getCacheStats,
  MAX_ARTWORK_CACHE_SIZE_MB,
  MIN_ARTWORK_CACHE_SIZE_MB,
  setArtworkCacheMaxBytes,
  setCacheMaxBytes,
  type ArtworkCacheStats,
  type CacheStats,
} from "../../internal/cache";
import { toCachedArtworkUrl } from "../../datasource/youtube/artwork";
import { setDebugOverlayEnabled, useDebugOverlayEnabled } from "../settings/debugOverlay";
import {
  DEFAULT_PRESENCE_SETTINGS,
  addSecretTrackShared,
  getPresenceStatus,
  getPresenceSettings,
  getSecretTracks,
  removeSecretTrackShared,
  savePresenceSettings,
  type PresenceSettings,
  type PresenceStatus,
  type SecretTrack,
} from "../../internal/presenceClient";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import {
  setExtraPlayerControlsAlwaysVisible,
  useExtraPlayerControlsAlwaysVisible,
} from "../settings/playerControls";
import {
  APP_THEMES,
  clearPersonalTheme,
  hasPersonalTheme,
  importCustomThemeCss,
  setAppTheme,
  setGlassThemeSettings,
  setMatrixThemeSettings,
  useAppTheme,
  useGlassThemeSettings,
  useMatrixThemeSettings,
  type AppTheme,
} from "../settings/themes";
import {
  captureKeyboardShortcut,
  formatKeyboardShortcut,
  KEYBOARD_SHORTCUT_ACTIONS,
  resetKeyboardShortcut,
  resetKeyboardShortcuts,
  setKeyboardShortcut,
  useKeyboardShortcuts,
  type KeyboardShortcutAction,
} from "../settings/keyboardShortcuts";
import {
  addLocalPlaylistPath,
  createLocalPlaylist,
  deleteLocalPlaylist,
  getLocalPlaylists,
  removeLocalPlaylistPath,
  subscribeToLocalPlaylists,
} from "../../player/localPlaylists";
import {
  setAuthenticatedStreaming,
  setYouTubeScrobbling,
  useAuthenticatedStreaming,
  useYouTubeScrobbling,
} from "../settings/youtubeAccount";
import {
  AUDIO_QUALITY_LABELS,
  setStreamingQuality,
  useStreamingQuality,
  type AudioQuality,
} from "../../internal/audioQuality";
import { setPluginEnabled, usePlugins } from "../../plugins/pluginHost";
import {
  rediscoverDownloads,
  setDownloadQuality,
  useDownloaderState,
} from "../../plugins/official/downloader/downloaderStore";
import { DOWNLOADER_PLUGIN_ID } from "../../plugins/official/downloader/manifest";
import { getYouTubeLinkStatus, refreshAuthSession, useAuth } from "../../auth/authClient";
import { QrCode } from "../components/QrCode";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInfo,
  type CreatedApiKey,
} from "../../auth/apiKeysClient";
import {
  createAdminUser,
  deleteAdminUser,
  getOAuthConfig,
  getOverview,
  getImageCache,
  formatImageCache,
  getRegistrationConfig,
  listUsers,
  resetAppData,
  resetUserTotp,
  revokeUserSessions,
  saveOAuthConfig,
  setInstanceTheme,
  setRegistrationConfig,
  setUserRole,
  type AdminOverview,
  type AdminUser,
  type ImageCacheReport,
  type OAuthProviderConfig,
  type RegistrationConfig,
} from "../../auth/adminClient";
import { SecurityCard } from "../components/SecurityCard";
import {
  pickLocalAudioDirectory,
  pickLocalAudioFiles,
} from "../../player/localFiles";
import styles from "./SettingsPage.module.css";

type SettingsTab = "about" | "system" | "shortcuts" | "window" | "plugins" | "api" | "admin";

/**
 * Pull a video id out of a pasted YouTube link, share URL, or bare id.
 * Secret Show matches on the id, so the input accepts every shape users paste.
 */
function extractVideoId(input: string): string | null {
  const bare = input.match(/^[A-Za-z0-9_-]{11}$/);
  if (bare) return input;
  try {
    const url = new URL(input);
    const fromParam = url.searchParams.get("v");
    if (fromParam && /^[A-Za-z0-9_-]{11}$/.test(fromParam)) return fromParam;
    const segments = url.pathname.split("/").filter(Boolean);
    const marker = segments.findIndex((segment) => segment === "shorts" || segment === "embed");
    const candidate = marker >= 0 ? segments[marker + 1] : segments.at(-1);
    if (candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate)) return candidate;
  } catch {
    // Not a URL — fall through to the null below.
  }
  return null;
}

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "about", label: "About" },
  { id: "system", label: "System" },
  { id: "window", label: "Style" },
  { id: "plugins", label: "Plugins" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "api", label: "API" },
  { id: "admin", label: "Admin" },
];

const THEME_SWATCH_COLORS: Record<AppTheme, string[]> = {
  dark: ["#070707", "#181818", "#ff0033"],
  light: ["#f4f5f7", "#ffffff", "#d7193f"],
  glass: ["#f4e9ff", "#5e4a67", "#f6c37a"],
  matrix: ["#020803", "#041208", "#4dff77"],
  sakura: ["#fdf5f8", "#ffffff", "#e2557f"],
  tokyo: ["#0b0416", "#241038", "#ff2d9a"],
  ghibli: ["#faf6ec", "#fffdf5", "#4e8f5a"],
  cel: ["#141026", "#241c44", "#ffd23f"],
  sunset: ["#170a12", "#38162a", "#ff7a45"],
  ocean: ["#03121a", "#0a2c3c", "#38c8e6"],
  nordic: ["#f4f7fa", "#ffffff", "#2f6f8f"],
  custom: ["#2a050d", "#6f1124", "#d9274f"],
};

interface CustomSelectOption<TValue extends string> {
  value: TValue;
  label: string;
}

interface CustomSelectProps<TValue extends string> {
  label: string;
  value: TValue;
  options: Array<CustomSelectOption<TValue>>;
  disabled?: boolean;
  onChange: (value: TValue) => void;
}

function CustomSelect<TValue extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: CustomSelectProps<TValue>) {
  const [open, setOpen] = useState(false);
  const selectId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) setOpen(true);
    }
  };

  return (
    <span ref={rootRef} className={styles.selectControl}>
      <button
        className={`${styles.selectInput} ${open ? styles.selectInputOpen : ""}`}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? selectId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleButtonKeyDown}
      >
        <span>{selectedOption?.label ?? ""}</span>
        <IconChevronDown size={17} aria-hidden="true" />
      </button>

      {open && !disabled ? (
        <span id={selectId} className={styles.selectMenu} role="listbox" aria-label={label}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                className={`${styles.selectOption} ${selected ? styles.selectOptionActive : ""}`}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {selected && <span className={styles.selectOptionDot} aria-hidden="true" />}
              </button>
            );
          })}
        </span>
      ) : null}
    </span>
  );
}

interface SettingsPageProps {
  libraryController: LibraryController;
  libraryState: LibraryState;
  onRestartOnboarding: () => void;
  onSignIn: () => Promise<void>;
}

export function SettingsPage({
  libraryController,
  libraryState,
  onRestartOnboarding,
  onSignIn,
}: SettingsPageProps) {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheSizeGb, setCacheSizeGb] = useState(DEFAULT_CACHE_SIZE_GB.toString());
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [artworkStats, setArtworkStats] = useState<ArtworkCacheStats | null>(null);
  const [artworkSizeMb, setArtworkSizeMb] = useState(String(DEFAULT_ARTWORK_CACHE_SIZE_MB));
  const [artworkNotice, setArtworkNotice] = useState<string | null>(null);
  const [localPlaylistName, setLocalPlaylistName] = useState("");
  const [localPlaylistPathInputs, setLocalPlaylistPathInputs] = useState<Record<string, string>>({});
  const [localPlaylistError, setLocalPlaylistError] = useState<string | null>(null);
  const [localPlaylistBrowsingId, setLocalPlaylistBrowsingId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [apiKeyCreated, setApiKeyCreated] = useState<CreatedApiKey | null>(null);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminOAuth, setAdminOAuth] = useState<OAuthProviderConfig | null>(null);
  const [adminRegistration, setAdminRegistration] = useState<RegistrationConfig | null>(null);
  const [imageCacheReport, setImageCacheReport] = useState<ImageCacheReport | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserRole, setNewUserRole] = useState<"admin" | "user">("user");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [oauthForm, setOauthForm] = useState({
    providerName: "",
    discoveryUrl: "",
    clientId: "",
    clientSecret: "",
  });
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetTotpCode, setResetTotpCode] = useState("");
  const [themeImporting, setThemeImporting] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [showCustomThemeWarning, setShowCustomThemeWarning] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("about");
  const [listeningShortcut, setListeningShortcut] = useState<KeyboardShortcutAction | null>(null);
  const keyboardShortcuts = useKeyboardShortcuts();
  const appTheme = useAppTheme();
  const glassThemeSettings = useGlassThemeSettings();
  const matrixThemeSettings = useMatrixThemeSettings();
  const extraPlayerControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();
  const auth = useAuth();
  // The admin's default theme, from the session payload. Personal choice wins.
  const instanceTheme = (
    auth.session.instanceTheme !== null &&
    APP_THEMES.some((theme) => theme.id === auth.session.instanceTheme)
      ? auth.session.instanceTheme
      : null
  ) as AppTheme | null;
  const authenticatedStreaming = useAuthenticatedStreaming();
  const youtubeScrobbling = useYouTubeScrobbling();
  const streamingQuality = useStreamingQuality();
  const plugins = usePlugins();
  const downloaderState = useDownloaderState();
  const localPlaylists = useSyncExternalStore(
    subscribeToLocalPlaylists,
    getLocalPlaylists,
    getLocalPlaylists,
  );
  const account = libraryState.library?.account;
  const isSignedIn = libraryState.status === "ready" && account;
  const googleUser = auth.session.user;
  const googleEnabled = auth.session.googleSignInEnabled;
  // How this browser got its OpenDeck session: the OIDC provider or a
  // local password — the chip must not claim "Google only" for password users.
  const authProvider = auth.session.authProvider;
  // Server truth only: the app library can be "ready" from OpenDeck's own
  // stored playlists, which must not masquerade as a linked YouTube account.
  const youtubeLinked = auth.session.youtubeLinked;
  const authPrompt = libraryState.authPrompt;
  const [ytVerifyNote, setYtVerifyNote] = useState<string | null>(null);
  const [ytVerifyBusy, setYtVerifyBusy] = useState(false);
  const accountPlaybackEnabled = authenticatedStreaming && youtubeScrobbling;
  const isAdmin = auth.session.role === "admin";
  const debugOverlayEnabled = useDebugOverlayEnabled();
  const [presenceSettings, setPresenceSettings] = useState<PresenceSettings>({
    ...DEFAULT_PRESENCE_SETTINGS,
  });
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus | null>(null);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  // Secret Show: songs that play freely but never reach Discord.
  const [secretTracks, setSecretTracks] = useState<SecretTrack[]>([]);
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const visibleTabs = SETTINGS_TABS.filter((tab) => tab.id !== "admin" || isAdmin);
  const activeTabIndex = Math.max(0, visibleTabs.findIndex((tab) => tab.id === activeTab));
  const authBusy = libraryState.status === "restoring"
    || libraryState.status === "authorizing"
    || libraryState.status === "loading";

  /** Activation link with the user code pre-filled — what the QR encodes. */
  const youtubeActivationUrl = (prompt: {
    verificationUrl?: string;
    userCode?: string;
  }): string => {
    if (!prompt.verificationUrl) return "https://www.youtube.com/activate";
    try {
      const url = new URL(prompt.verificationUrl);
      if (prompt.userCode) url.searchParams.set("user_code", prompt.userCode);
      return url.toString();
    } catch {
      return prompt.verificationUrl;
    }
  };

  const handleConnectYouTube = async () => {
    setYtVerifyNote(null);
    await onSignIn();
  };

  /** Verify button: checks the link right now instead of waiting on polling. */
  const handleVerifyYouTube = async () => {
    if (ytVerifyBusy) return;
    setYtVerifyBusy(true);
    try {
      const status = await getYouTubeLinkStatus();
      if (status.linked) {
        setYtVerifyNote("Verified — YouTube Music is connected.");
      } else if (status.state === "error") {
        setYtVerifyNote(status.error ?? "YouTube sign-in failed. Please try again.");
      } else {
        setYtVerifyNote(
          "Still waiting — finish the sign-in on your phone, then press Verify again.",
        );
      }
    } catch (verifyError) {
      setYtVerifyNote(
        verifyError instanceof Error ? verifyError.message : "Unable to verify right now.",
      );
    } finally {
      setYtVerifyBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void getCacheStats()
      .then((stats) => {
        if (!active) return;
        setCacheStats(stats);
        setCacheSizeGb((stats.maxBytes / 1024 ** 3).toString());
      })
      .catch(() => {
        if (active) setCacheError("Unable to load cache settings.");
      });
    return () => {
      active = false;
    };
  }, []);

  // Artwork usage is a global, signed-in-only view: the server answers 401
  // for anonymous callers, so don't fire the request until there is a session.
  useEffect(() => {
    if (!auth.session.authenticated) {
      setArtworkStats(null);
      return undefined;
    }
    let active = true;
    void getArtworkCacheStats()
      .then((stats) => {
        if (!active) return;
        setArtworkStats(stats);
        if (stats.maxBytes > 0) {
          setArtworkSizeMb(String(Math.round(stats.maxBytes / 1024 ** 2)));
        }
      })
      .catch(() => {
        if (active) setArtworkStats(null);
      });
    return () => {
      active = false;
    };
  }, [auth.session.authenticated]);

  useEffect(() => {
    if (!auth.session.authenticated) {
      setApiKeys([]);
      setApiKeyCreated(null);
      return undefined;
    }
    let active = true;
    void listApiKeys()
      .then((keys) => {
        if (active) setApiKeys(keys);
      })
      .catch((error) => {
        if (active) {
          setApiKeyError(error instanceof Error ? error.message : "Unable to load API keys.");
        }
      });
    return () => {
      active = false;
    };
  }, [auth.session.authenticated]);

  // The Admin tab only exists for admins; bounce off it if the role goes away.
  useEffect(() => {
    if (activeTab === "admin" && !isAdmin) setActiveTab("about");
  }, [activeTab, isAdmin]);

  // Load instance data when the Admin tab is actually viewed.
  useEffect(() => {
    if (!isAdmin || activeTab !== "admin") return undefined;
    let active = true;
    setAdminError(null);
    const load = async () => {
      try {
        const [overview, users, oauth, registration, imageCache] = await Promise.all([
          getOverview(),
          listUsers(),
          getOAuthConfig(),
          getRegistrationConfig(),
          getImageCache(),
        ]);
        if (!active) return;
        setAdminOverview(overview);
        setAdminUsers(users);
        setAdminOAuth(oauth.provider);
        setAdminRegistration(registration.registration);
        setImageCacheReport(imageCache);
        setOauthForm({
          providerName: oauth.provider.providerName,
          discoveryUrl: oauth.provider.discoveryUrl,
          clientId: oauth.provider.clientId,
          clientSecret: "",
        });
      } catch (error) {
        if (active) {
          setAdminError(error instanceof Error ? error.message : "Unable to load admin data.");
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [isAdmin, activeTab]);

  useEffect(() => {
    if (!auth.session.authenticated) return undefined;
    let active = true;
    void Promise.all([getPresenceSettings(), getPresenceStatus(), getSecretTracks()]).then(
      ([settings, status, secret]) => {
        if (!active) return;
        setPresenceSettings(settings);
        setPresenceStatus(status);
        setSecretTracks(secret.tracks);
      },
    );
    return () => {
      active = false;
    };
  }, [auth.session.authenticated]);

  const savePresence = async (next: PresenceSettings) => {
    setPresenceBusy(true);
    setPresenceError(null);
    try {
      const saved = await savePresenceSettings(next);
      setPresenceSettings(saved);
      // The switch can change whether the server reaches Discord at all.
      setPresenceStatus(await getPresenceStatus());
    } catch {
      setPresenceError("Unable to save Discord settings.");
    } finally {
      setPresenceBusy(false);
    }
  };

  /** Add by video id or YouTube link — the id is what the server matches. */
  const handleAddSecretTrack = async () => {
    const trimmed = secretInput.trim();
    if (!trimmed) return;
    const videoId = extractVideoId(trimmed);
    if (!videoId) {
      setSecretError("Paste a YouTube link or video id.");
      return;
    }
    setSecretBusy(true);
    setSecretError(null);
    try {
      const tracks = await addSecretTrackShared({ videoId, title: videoId, artist: "" });
      setSecretTracks(tracks);
      setSecretInput("");
    } catch {
      setSecretError("Could not add to Secret Show.");
    } finally {
      setSecretBusy(false);
    }
  };

  const handleRemoveSecretTrack = async (videoId: string) => {
    setSecretBusy(true);
    setSecretError(null);
    try {
      const tracks = await removeSecretTrackShared(videoId);
      setSecretTracks(tracks);
    } catch {
      setSecretError("Could not remove from Secret Show.");
    } finally {
      setSecretBusy(false);
    }
  };

  const saveCacheSize = async () => {
    const sizeGb = Number(cacheSizeGb);
    if (!Number.isFinite(sizeGb) || sizeGb < 0.25 || sizeGb > 64) {
      setCacheError("Cache size must be between 0.25 GB and 64 GB.");
      return;
    }

    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await setCacheMaxBytes(Math.round(sizeGb * 1024 ** 3)));
    } catch {
      setCacheError("Unable to save the cache size.");
    } finally {
      setCacheBusy(false);
    }
  };

  const handleClearCache = async () => {
    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await clearCache());
    } catch {
      setCacheError("Unable to clear cached content.");
    } finally {
      setCacheBusy(false);
    }
  };

  /**
   * Artwork budget. Admin-only on the server because the cache is shared by
   * every account, so a non-admin save surfaces the 403 as an error rather
   * than silently doing nothing.
   */
  const saveArtworkCacheSize = async () => {
    const sizeMb = Number(artworkSizeMb);
    if (
      !Number.isFinite(sizeMb)
      || sizeMb < MIN_ARTWORK_CACHE_SIZE_MB
      || sizeMb > MAX_ARTWORK_CACHE_SIZE_MB
    ) {
      setCacheError(
        `Artwork cache size must be between ${MIN_ARTWORK_CACHE_SIZE_MB} MB and ${MAX_ARTWORK_CACHE_SIZE_MB / 1024} GB.`,
      );
      return;
    }
    setCacheBusy(true);
    setCacheError(null);
    setArtworkNotice(null);
    try {
      setArtworkStats(await setArtworkCacheMaxBytes(Math.round(sizeMb * 1024 ** 2)));
      setArtworkNotice("Artwork budget saved. The cache trims itself immediately if it is over.");
    } catch {
      setCacheError("Unable to save the artwork cache size.");
    } finally {
      setCacheBusy(false);
    }
  };

  /**
   * "Format" — the manual reset. The server also VACUUMs, so the disk space
   * really comes back rather than sitting on SQLite's free list.
   */
  const handleFormatArtworkCache = async () => {
    setCacheBusy(true);
    setCacheError(null);
    setArtworkNotice(null);
    try {
      setArtworkStats(await formatArtworkCache());
      setArtworkNotice("Artwork cache formatted. Every picture will be re-fetched as you browse.");
    } catch {
      setCacheError("Unable to format the artwork cache.");
    } finally {
      setCacheBusy(false);
    }
  };

  const handleCreateLocalPlaylist = () => {
    setLocalPlaylistError(null);
    try {
      createLocalPlaylist(localPlaylistName);
      setLocalPlaylistName("");
    } catch (error) {
      setLocalPlaylistError(error instanceof Error ? error.message : "Unable to create local playlist.");
    }
  };

  const handleCreateApiKey = async () => {
    const label = apiKeyLabel.trim();
    if (!label) return;
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      const created = await createApiKey(label);
      setApiKeyCreated(created);
      setApiKeyCopied(false);
      setApiKeyLabel("");
      setApiKeys((current) => [
        {
          id: created.id,
          label: created.label,
          keyPrefix: created.keyPrefix,
          createdAt: created.createdAt,
          lastUsedAt: null,
          stats: { totalPlays: 0, playsLast7Days: 0, lastPlayedAt: null },
        },
        ...current.filter((key) => key.id !== created.id),
      ]);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Unable to create the API key.");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleRevokeApiKey = async (id: string) => {
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await revokeApiKey(id);
      setApiKeys((current) => current.filter((key) => key.id !== id));
      if (apiKeyCreated?.id === id) setApiKeyCreated(null);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Unable to revoke the API key.");
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleCopyApiKey = async () => {
    if (!apiKeyCreated) return;
    try {
      await navigator.clipboard.writeText(apiKeyCreated.key);
      setApiKeyCopied(true);
    } catch {
      setApiKeyError("Unable to copy — select the key and copy it manually.");
    }
  };

  /* ------------------------------------------------------------------
   * Admin panel actions.
   * ------------------------------------------------------------------ */

  const runAdmin = async (action: () => Promise<void>, notice?: string): Promise<void> => {
    setAdminBusy(true);
    setAdminError(null);
    setAdminNotice(null);
    try {
      await action();
      if (notice) setAdminNotice(notice);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "That action failed.");
    } finally {
      setAdminBusy(false);
    }
  };

  const reloadAdminData = async (): Promise<void> => {
    const [overview, users] = await Promise.all([getOverview(), listUsers()]);
    setAdminOverview(overview);
    setAdminUsers(users);
  };

  const handleCreateUser = () =>
    runAdmin(async () => {
      await createAdminUser({
        email: newUserEmail.trim(),
        password: newUserPassword,
        name: newUserName.trim() || undefined,
        role: newUserRole,
      });
      setNewUserEmail("");
      setNewUserPassword("");
      setNewUserName("");
      setNewUserRole("user");
      await reloadAdminData();
    }, "Account created.");

  const handleRoleChange = (userId: string, role: "admin" | "user") =>
    runAdmin(async () => {
      await setUserRole(userId, role);
      await reloadAdminData();
    }, "Role updated.");

  const handleRevokeSessions = (userId: string) =>
    runAdmin(async () => {
      await revokeUserSessions(userId);
      await reloadAdminData();
    }, "Sessions revoked.");

  const handleAdminTotpReset = (userId: string) =>
    runAdmin(async () => {
      await resetUserTotp(userId);
      await reloadAdminData();
    }, "Two-step verification cleared.");

  const handleDeleteUser = (userId: string) => {
    if (deleteConfirmId !== userId) {
      setDeleteConfirmId(userId);
      return;
    }
    setDeleteConfirmId(null);
    void runAdmin(async () => {
      await deleteAdminUser(userId);
      await reloadAdminData();
    }, "Account deleted.");
  };

  const handleSaveOAuth = () =>
    runAdmin(async () => {
      const saved = await saveOAuthConfig({
        providerName: oauthForm.providerName.trim(),
        discoveryUrl: oauthForm.discoveryUrl.trim(),
        clientId: oauthForm.clientId.trim(),
        // Empty keeps the current secret; type to rotate it.
        ...(oauthForm.clientSecret ? { clientSecret: oauthForm.clientSecret } : {}),
      });
      setAdminOAuth(saved.provider);
      setOauthForm((current) => ({ ...current, clientSecret: "" }));
      await refreshAuthSession();
    }, "Sign-in settings saved — effective immediately.");

  const handleToggleRegistration = (enabled: boolean) =>
    runAdmin(async () => {
      const saved = await setRegistrationConfig(enabled);
      setAdminRegistration(saved.registration);
    }, enabled
      ? "Account creation is open — the sign-up option is live on the login page."
      : "Account creation closed — only existing accounts and admin-created ones can sign in.");

  const handleInstanceThemeSelect = (theme: AppTheme) =>
    runAdmin(async () => {
      await setInstanceTheme(theme);
      // Refresh the session so the new instance theme reaches every surface,
      // including this admin's own view where no personal theme is set.
      await auth.refresh();
    }, `Instance theme saved — sign-in and unthemed accounts now wear "${
      APP_THEMES.find((entry) => entry.id === theme)?.label ?? theme
    }".`);

  const handleResetAppData = () => {
    if (!resetConfirming) {
      setResetConfirming(true);
      return;
    }
    void runAdmin(async () => {
      await resetAppData(resetTotpCode.trim());
      setResetConfirming(false);
      setResetTotpCode("");
    }, "Instance data reset: settings and cache cleared, all other sessions signed out.");
  };

  const handleAddLocalPlaylistPath = (playlistId: string) => {
    setLocalPlaylistError(null);
    const path = localPlaylistPathInputs[playlistId]?.trim() ?? "";
    if (!path) {
      setLocalPlaylistError("Enter a folder path before adding it.");
      return;
    }
    addLocalPlaylistPath(playlistId, path);
    setLocalPlaylistPathInputs((current) => ({ ...current, [playlistId]: "" }));
  };

  const handleBrowseLocalPlaylistPath = async (playlistId: string) => {
    setLocalPlaylistError(null);
    setLocalPlaylistBrowsingId(playlistId);
    try {
      // Web equivalent of the desktop folder dialog: File System Access API
      // directory picker, falling back to a plain file input.
      try {
        const files = await pickLocalAudioDirectory();
        const root = files[0]?.path.split("/")[0];
        if (root) addLocalPlaylistPath(playlistId, root);
      } catch (directoryError) {
        if (directoryError instanceof DOMException && directoryError.name === "AbortError") {
          return;
        }
        const files = await pickLocalAudioFiles();
        for (const file of files) addLocalPlaylistPath(playlistId, file.path);
      }
      setLocalPlaylistPathInputs((current) => ({
        ...current,
        [playlistId]: "",
      }));
    } catch (error) {
      setLocalPlaylistError(
        error instanceof Error ? error.message : "Unable to add local audio files.",
      );
    } finally {
      setLocalPlaylistBrowsingId(null);
    }
  };

  const handleThemeSelect = (theme: AppTheme) => {
    setThemeError(null);
    setAppTheme(theme);
  };

  const handleImportCustomTheme = async () => {
    setThemeError(null);
    setShowCustomThemeWarning(true);
  };

  const handleRediscoverDownloads = async () => {
    setPluginError(null);
    setPluginBusy(true);
    try {
      await rediscoverDownloads();
    } catch {
      setPluginError("Unable to verify offline audio.");
    } finally {
      setPluginBusy(false);
    }
  };

  const handleConfirmCustomThemeImport = async () => {
    setThemeError(null);
    setShowCustomThemeWarning(false);
    setThemeImporting(true);
    try {
      const css = await new Promise<string | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".css,text/css";
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          void file.text().then(resolve).catch(() => resolve(null));
        });
        input.addEventListener("cancel", () => resolve(null));
        input.click();
      });
      if (!css) return;
      await importCustomThemeCss(css);
    } catch (error) {
      setThemeError(error instanceof Error ? error.message : String(error));
    } finally {
      setThemeImporting(false);
    }
  };

  const handleShortcutCapture = (
    event: KeyboardEvent<HTMLButtonElement>,
    action: KeyboardShortcutAction,
  ) => {
    if (listeningShortcut !== action) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.code === "Escape") {
      setListeningShortcut(null);
      return;
    }

    const shortcut = captureKeyboardShortcut(event.nativeEvent);
    if (!shortcut) return;

    setKeyboardShortcut(action, shortcut);
    setListeningShortcut(null);
  };

  useEffect(() => {
    if (!listeningShortcut) return undefined;

    const handleShortcutKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.code === "Escape") {
        setListeningShortcut(null);
        return;
      }

      const shortcut = captureKeyboardShortcut(event);
      if (!shortcut) return;

      setKeyboardShortcut(listeningShortcut, shortcut);
      setListeningShortcut(null);
    };

    window.addEventListener("keydown", handleShortcutKeyDown, true);
    return () => window.removeEventListener("keydown", handleShortcutKeyDown, true);
  }, [listeningShortcut]);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  /** Label for a cached picture: host + last path segment, query string dropped. */
  const describeArtwork = (url: string) => {
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
      return `${parsed.hostname}/${segment}`;
    } catch {
      return url;
    }
  };

  /** Admin-panel Format — same server operation, refreshed report after. */
  const handleAdminFormatArtwork = async () => {
    setAdminBusy(true);
    setAdminError(null);
    setAdminNotice(null);
    try {
      const result = await formatImageCache();
      setImageCacheReport({ stats: result.stats, images: [] });
      setAdminOverview((current) =>
        current ? { ...current, imageCacheBytes: result.stats.usedBytes } : current,
      );
      setAdminNotice("Artwork cache formatted — every cached picture was dropped.");
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Unable to format the artwork cache.");
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Application</span>
        <h1>Settings</h1>
        <p>Manage account, system, and window behavior.</p>
      </div>

      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Settings categories"
        style={{
          "--active-tab-offset": `${activeTabIndex * 100}%`,
          "--tab-count": visibleTabs.length,
        } as CSSProperties}
      >
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? styles.activeTab : ""}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "about" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="About settings">
          <section className={styles.card} aria-labelledby="account-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="account-settings-title">Account</h2>
                <p>
                  {!googleUser
                    ? googleEnabled
                      ? "Sign in with Google to unlock your library, playlists, and settings."
                      : "Sign in to unlock your library, playlists, and settings."
                    : youtubeLinked
                      ? "Signed in — YouTube Music account connected."
                      : "Signed in — connect your YouTube Music account."}
                </p>
              </div>
              <span className={`${styles.status} ${isSignedIn || youtubeLinked ? styles.connected : ""}`}>
                {isSignedIn && youtubeLinked
                  ? "Connected"
                  : googleUser
                    ? authProvider === "google" ? "Google only" : "Signed in"
                    : "Signed out"}
              </span>
            </div>

            <div className={styles.accountRow}>
              {account?.artworkUrl ? (
                <img
                  className={styles.avatar}
                  src={toCachedArtworkUrl(account.artworkUrl)}
                  alt=""
                />
              ) : (
                <div className={styles.avatarPlaceholder}>
                  <IconUser size={30} />
                </div>
              )}

              <div className={styles.accountDetails}>
                <span className={styles.accountName}>
                  {googleUser?.name ?? account?.name ?? "Not signed in"}
                </span>
                <span className={styles.accountDescription}>
                  {!googleUser
                    ? googleEnabled
                      ? "Use your Google account to sign in."
                      : "Use your email and password to sign in."
                    : youtubeLinked
                      ? account?.name
                        ? `YouTube Music: ${account.name}`
                        : "Your library and listening history are available."
                    : "Connect YouTube Music to load your library."}
                </span>
              </div>

              {!googleUser ? (                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleConnectYouTube()}
                  >
                    <IconLogin size={18} />
                    {authBusy
                      ? "Connecting..."
                      : googleEnabled
                        ? "Sign in with Google"
                        : "Sign in"}
                  </button>
              ) : !youtubeLinked ? (
                <div className={styles.accountActions}>
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleConnectYouTube()}
                  >
                    <IconLogin size={18} />
                    {authBusy ? "Waiting for Google..." : "Connect YouTube Music"}
                  </button>
                  {/* The app is gated behind this account: without YouTube
                      linked there used to be no way back out. */}
                  <button
                    className={styles.signOutButton}
                    type="button"
                    onClick={() => void libraryController.signOut()}
                  >
                    <IconLogout size={18} />
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  className={styles.signOutButton}
                  type="button"
                  onClick={() => void libraryController.signOut()}
                >
                  <IconLogout size={18} />
                  Sign out
                </button>
              )}
            </div>

            {libraryState.status === "authorizing" && authPrompt && (
              <div className={styles.actionRow} role="status">
                <span className={styles.toggleDescription}>
                  <strong>Approve YouTube Music access</strong>
                  <span>
                    Scan with your phone — it opens YouTube's activation page with the
                    code pre-filled. Or open <u>{authPrompt.verificationUrl}</u> and type
                    the code yourself
                    {authPrompt.expiresInSec
                      ? ` (expires in ${Math.ceil(authPrompt.expiresInSec / 60)} min)`
                      : ""}.
                  </span>
                  {ytVerifyNote && (
                    <span className={styles.qrVerifyNote}>{ytVerifyNote}</span>
                  )}
                </span>
                <span className={styles.authQrGroup}>
                  {authPrompt.userCode && (
                    <strong className={styles.authQrCode}>{authPrompt.userCode}</strong>
                  )}
                  <QrCode
                    value={youtubeActivationUrl(authPrompt)}
                    size={120}
                    label="YouTube Music activation QR code"
                  />
                  <button
                    className={styles.qrVerifyButton}
                    type="button"
                    disabled={ytVerifyBusy}
                    onClick={() => void handleVerifyYouTube()}
                  >
                    {ytVerifyBusy ? "Checking…" : "Verify"}
                  </button>
                </span>
              </div>
            )}

            {!googleUser && auth.error && (
              <p className={styles.error}>{auth.error}</p>
            )}
            {libraryState.error && <p className={styles.error}>{libraryState.error}</p>}

            <div className={styles.settingsList}>
              <label className={`${styles.settingRow} ${!isSignedIn ? styles.toggleRowDisabled : ""}`}>
                <span className={styles.toggleDescription}>
                  <strong>Stream with your account</strong>
                  <span>Use your signed-in YouTube account for playback and send your listening history to YouTube Music.</span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={isSignedIn ? accountPlaybackEnabled : false}
                  disabled={!isSignedIn}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setAuthenticatedStreaming(enabled);
                    setYouTubeScrobbling(enabled);
                  }}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>

              <div
                className={`${styles.selectRow} ${
                  !isSignedIn || !accountPlaybackEnabled ? styles.selectRowDisabled : ""
                }`}
              >
                <span className={styles.toggleDescription}>
                  <strong>Playback quality</strong>
                  <span>Requires Stream with your account to send listening history to YouTube Music.</span>
                </span>
                <CustomSelect
                  label="Playback quality"
                  value={streamingQuality}
                  disabled={!isSignedIn || !accountPlaybackEnabled}
                  onChange={setStreamingQuality}
                  options={(Object.keys(AUDIO_QUALITY_LABELS) as AudioQuality[]).map((quality) => ({
                    value: quality,
                    label: AUDIO_QUALITY_LABELS[quality],
                  }))}
                />
              </div>
            </div>
          </section>

          <SecurityCard />

          <section className={styles.card} aria-labelledby="discord-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="discord-settings-title">Discord Rich Presence</h2>
                <p>
                  Show what you are listening to on your Discord profile, with the
                  artwork and a link back. Tracks played through the API count too.
                </p>
              </div>
              <span className={styles.status}>
                {!presenceStatus?.configured
                  ? "Not set up"
                  : presenceStatus.connected
                    ? "Connected"
                    : presenceStatus.unavailable
                      ? "No Discord here"
                      : "Idle"}
              </span>
            </div>

            {presenceStatus?.configured && !presenceStatus.connected && (
              <p className={styles.toggleDescription}>
                This server has no Discord client to talk to. Rich Presence only
                reaches a Discord running on the same machine as OpenDeck, so a
                remote or headless server cannot push to your profile.
              </p>
            )}

            <div className={styles.settingsList}>
              <label className={styles.toggleRow}>
                <span className={styles.toggleDescription}>
                  <strong>Show what I am playing</strong>
                  <span>Off by default. Only you control this; it is per account.</span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={presenceSettings.enabled}
                  disabled={presenceBusy}
                  onChange={(event) =>
                    void savePresence({ ...presenceSettings, enabled: event.target.checked })}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>

              <label className={styles.toggleRow}>
                <span className={styles.toggleDescription}>
                  <strong>Show the platform name</strong>
                  <span>Adds "via OpenDeck" so friends know where it is playing.</span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={presenceSettings.showPlatform}
                  disabled={presenceBusy || !presenceSettings.enabled}
                  onChange={(event) =>
                    void savePresence({ ...presenceSettings, showPlatform: event.target.checked })}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>

              <label className={styles.cacheSizeField}>
                <span>Your status message</span>
                <input
                  type="text"
                  maxLength={128}
                  placeholder="Coding OpenDeck"
                  value={presenceSettings.customMessage}
                  disabled={presenceBusy || !presenceSettings.enabled}
                  onChange={(event) =>
                    setPresenceSettings({ ...presenceSettings, customMessage: event.target.value })}
                  onBlur={() => void savePresence(presenceSettings)}
                />
                <span className={styles.toggleDescription}>
                  Shown above the track. Leave blank for just the song.
                </span>
              </label>
            </div>

            {presenceError && <p className={styles.error}>{presenceError}</p>}
          </section>

          <section className={styles.card} aria-labelledby="secret-show-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="secret-show-title">Secret Show</h2>
                <p>
                  Songs on this list play freely but never reach Discord — your profile
                  shows nothing playing while one is on. Right-click any song for a
                  one-click toggle, or paste a link below.
                </p>
              </div>
              <span className={styles.status}>
                {secretTracks.length > 0 ? `${secretTracks.length} hidden` : "Empty"}
              </span>
            </div>

            <div className={styles.settingsList}>
              <div className={styles.localPlaylistsBlock}>
                <div className={styles.localPlaylistHeader}>
                  <span className={styles.toggleDescription}>
                    <strong>Add a song</strong>
                    <span>A YouTube link or an 11-character video id.</span>
                  </span>
                  <div className={styles.localPlaylistCreate}>
                    <input
                      type="text"
                      value={secretInput}
                      placeholder="https://music.youtube.com/watch?v=…"
                      aria-label="Song link or video id to hide from Discord"
                      disabled={secretBusy}
                      onChange={(event) => setSecretInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleAddSecretTrack();
                      }}
                    />
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      disabled={secretBusy || !secretInput.trim()}
                      onClick={() => void handleAddSecretTrack()}
                    >
                      <IconEyeOff size={18} />
                      Hide it
                    </button>
                  </div>
                </div>

                {secretError && <p className={styles.error}>{secretError}</p>}

                {secretTracks.length > 0 ? (
                  <div className={styles.localPlaylistList}>
                    {secretTracks.map((secret) => (
                      <div className={styles.localPlaylistItem} key={secret.videoId}>
                        <div className={styles.localPlaylistTitleRow}>
                          <span className={styles.localPlaylistTitle}>
                            <IconEyeOff size={18} aria-hidden="true" />
                            {secret.title}
                          </span>
                          <button
                            className={styles.dangerButton}
                            type="button"
                            disabled={secretBusy}
                            onClick={() => void handleRemoveSecretTrack(secret.videoId)}
                          >
                            <IconTrash size={18} />
                            Show again
                          </button>
                        </div>
                        <span className={styles.toggleDescription}>
                          <span>
                            {secret.artist ? `${secret.artist} · ` : ""}{secret.videoId}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className={styles.toggleDescription}>
                    <span>Nothing hidden yet.</span>
                  </span>
                )}
              </div>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="about-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="about-settings-title">About</h2>
            </div>

            <div className={styles.settingsList}>

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Quick start</strong>
                  <span>Replay the guided introduction.</span>
                </span>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={onRestartOnboarding}
                >
                  <IconRefresh size={18} />
                  Start onboarding
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="System settings">
          <section className={styles.card} aria-labelledby="system-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="system-settings-title">System</h2>
            </div>

            <div className={styles.settingsList}>

              <div className={styles.localPlaylistsBlock}>
                <div className={styles.localPlaylistHeader}>
                  <span className={styles.toggleDescription}>
                    <strong>Local playlists</strong>
                    <span>Create playlists from folders on this computer.</span>
                  </span>
                  <div className={styles.localPlaylistCreate}>
                    <input
                      type="text"
                      value={localPlaylistName}
                      placeholder="Playlist name"
                      aria-label="Local playlist name"
                      onChange={(event) => setLocalPlaylistName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleCreateLocalPlaylist();
                      }}
                    />
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={handleCreateLocalPlaylist}
                    >
                      <IconFolderPlus size={18} />
                      Create local playlist
                    </button>
                  </div>
                </div>

                {localPlaylistError && <p className={styles.error}>{localPlaylistError}</p>}

                {localPlaylists.length > 0 && (
                  <div className={styles.localPlaylistList}>
                    {localPlaylists.map((playlist) => (
                      <div className={styles.localPlaylistItem} key={playlist.id}>
                        <div className={styles.localPlaylistTitleRow}>
                          <span className={styles.localPlaylistTitle}>
                            <IconFolder size={18} aria-hidden="true" />
                            {playlist.name}
                          </span>
                          <button
                            className={styles.dangerButton}
                            type="button"
                            onClick={() => deleteLocalPlaylist(playlist.id)}
                          >
                            <IconTrash size={18} />
                            Delete
                          </button>
                        </div>

                        <div className={styles.localPathControls}>
                          <span className={styles.localPathInputGroup}>
                            <input
                              type="text"
                              value={localPlaylistPathInputs[playlist.id] ?? ""}
                              placeholder="/Users/name/Music"
                              aria-label={`Folder path for ${playlist.name}`}
                              onChange={(event) => setLocalPlaylistPathInputs((current) => ({
                                ...current,
                                [playlist.id]: event.target.value,
                              }))}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") handleAddLocalPlaylistPath(playlist.id);
                              }}
                            />
                            <button
                              type="button"
                              className={styles.localPathBrowseButton}
                              disabled={localPlaylistBrowsingId === playlist.id}
                              title="Browse for folder"
                              aria-label={`Browse for a folder for ${playlist.name}`}
                              onClick={() => void handleBrowseLocalPlaylistPath(playlist.id)}
                            >
                              <IconFolderOpen size={17} aria-hidden="true" />
                            </button>
                          </span>
                          <button
                            className={styles.secondaryButton}
                            type="button"
                            onClick={() => handleAddLocalPlaylistPath(playlist.id)}
                          >
                            Add
                          </button>
                        </div>

                        {playlist.paths.length > 0 ? (
                          <div className={styles.localPathList}>
                            {playlist.paths.map((path) => (
                              <div className={styles.localPathItem} key={path}>
                                <span>{path}</span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${path}`}
                                  onClick={() => removeLocalPlaylistPath(playlist.id, path)}
                                >
                                  <IconTrash size={16} aria-hidden="true" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className={styles.localPlaylistEmpty}>No paths added yet.</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>


              <div className={styles.cacheRow}>
                <div className={styles.cacheUsage}>
                  <span>Cache</span>
                  <strong>
                    {cacheStats
                      ? `${formatBytes(cacheStats.usedBytes)} of ${formatBytes(cacheStats.maxBytes)}`
                      : "Loading..."}
                  </strong>
                  <span>{cacheStats?.entryCount ?? 0} cached items</span>
                </div>

                <div className={styles.cacheControls}>
                  <label className={styles.cacheSizeField}>
                    <span>Maximum size</span>
                    <span className={styles.inputWithUnit}>
                      <input
                        type="number"
                        min="0.25"
                        max="64"
                        step="0.25"
                        value={cacheSizeGb}
                        disabled={cacheBusy}
                        onChange={(event) => setCacheSizeGb(event.target.value)}
                      />
                      <span>GB</span>
                    </span>
                  </label>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={cacheBusy}
                    onClick={() => void saveCacheSize()}
                  >
                    Save
                  </button>
                  <button
                    className={styles.dangerButton}
                    type="button"
                    disabled={cacheBusy}
                    onClick={() => void handleClearCache()}
                  >
                    <IconTrash size={18} />
                    Clear cache
                  </button>
                </div>
              </div>

              <div className={styles.cacheRow}>
                <div className={styles.cacheUsage}>
                  <span>Artwork cache</span>
                  <strong>
                    {artworkStats
                      ? `${formatBytes(artworkStats.usedBytes)} of ${formatBytes(artworkStats.maxBytes)}`
                      : "Sign in to see usage"}
                  </strong>
                  <span>
                    {artworkStats
                      ? `${artworkStats.entryCount} images${
                          artworkStats.usageRatio >= 0.8
                            ? ` — ${Math.round(artworkStats.usageRatio * 100)}% full`
                            : ""
                        }`
                      : "Shared across every account"}
                  </span>
                  {artworkStats && (
                    <span
                      className={styles.artworkMeter}
                      role="progressbar"
                      aria-label="Artwork cache usage"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(artworkStats.usageRatio * 100)}
                    >
                      <span
                        className={`${styles.artworkMeterFill}${
                          artworkStats.usageRatio >= 0.9 ? ` ${styles.artworkMeterHigh}` : ""
                        }`}
                        style={{ width: `${Math.max(2, artworkStats.usageRatio * 100)}%` }}
                      />
                    </span>
                  )}
                </div>

                {isAdmin ? (
                  <div className={styles.cacheControls}>
                    <label className={styles.cacheSizeField}>
                      <span>Maximum size</span>
                      <span className={styles.inputWithUnit}>
                        <input
                          type="number"
                          min={MIN_ARTWORK_CACHE_SIZE_MB}
                          max={MAX_ARTWORK_CACHE_SIZE_MB}
                          step="64"
                          value={artworkSizeMb}
                          disabled={cacheBusy}
                          onChange={(event) => setArtworkSizeMb(event.target.value)}
                        />
                        <span>MB</span>
                      </span>
                    </label>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      disabled={cacheBusy}
                      onClick={() => void saveArtworkCacheSize()}
                    >
                      Save
                    </button>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      disabled={cacheBusy}
                      onClick={() => void handleFormatArtworkCache()}
                    >
                      <IconTrash size={18} />
                      Format artwork
                    </button>
                  </div>
                ) : (
                  <p className={styles.status}>
                    Album art and thumbnails are cached once for the whole instance. An
                    administrator sets the budget and can format it.
                  </p>
                )}
              </div>

              {artworkNotice && <p className={styles.status}>{artworkNotice}</p>}

              {cacheError && <p className={styles.error}>{cacheError}</p>}
            </div>
          </section>
        </div>
      )}

      {activeTab === "plugins" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="Plugin settings">
          <section className={styles.card} aria-labelledby="plugins-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="plugins-settings-title">Plugins</h2>
                <p>Enable plugins and manage their app-rendered settings.</p>
              </div>
            </div>

            <div className={styles.pluginList}>
              {plugins.map((plugin) => (
                <div className={styles.pluginItem} key={plugin.manifest.id}>
                  <label className={styles.pluginHeader}>
                    <span className={styles.toggleDescription}>
                      <strong>{plugin.manifest.name}</strong>
                      <span>
                        {plugin.manifest.kind === "official"
                          ? "Plugin. It can be disabled, but not removed."
                          : "Imported plugin."}
                      </span>
                    </span>
                    <input
                      className={styles.toggleInput}
                      type="checkbox"
                      checked={plugin.enabled}
                      onChange={(event) => setPluginEnabled(plugin.manifest.id, event.target.checked)}
                    />
                    <span className={styles.toggle} aria-hidden="true" />
                  </label>

                  {plugin.enabled && plugin.manifest.id === DOWNLOADER_PLUGIN_ID && (
                    <div className={styles.pluginSettings}>

                      <div className={styles.selectRow}>
                        <span className={styles.toggleDescription}>
                          <strong>Quality</strong>
                          <span>Offline audio keeps the best container YouTube exposes for the selected quality.</span>
                        </span>
                        <CustomSelect<AudioQuality>
                          label="Offline quality"
                          value={downloaderState.settings.quality}
                          onChange={(quality) => void setDownloadQuality(quality)}
                          options={[
                            { value: "high", label: AUDIO_QUALITY_LABELS.high },
                            { value: "normal", label: AUDIO_QUALITY_LABELS.normal },
                            { value: "low", label: AUDIO_QUALITY_LABELS.low },
                          ]}
                        />
                      </div>

                      <div className={styles.actionRow}>
                        <span className={styles.toggleDescription}>
                          <strong>Verify offline audio</strong>
                          <span>Re-check stored offline audio against browser storage and drop entries whose audio is gone.</span>
                        </span>
                        <button
                          className={styles.secondaryButton}
                          type="button"
                          disabled={pluginBusy}
                          onClick={() => void handleRediscoverDownloads()}
                        >
                          <IconRefresh size={18} />
                          Verify
                        </button>
                      </div>

                      {pluginError && <p className={styles.error}>{pluginError}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === "shortcuts" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="Keyboard shortcut settings">
          <section className={styles.card} aria-labelledby="keyboard-shortcuts-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="keyboard-shortcuts-settings-title">Keyboard shortcuts</h2>
            </div>

            <div className={styles.settingsList}>
              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Reset shortcuts</strong>
                  <span>Restore every keyboard shortcut to its default.</span>
                </span>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={resetKeyboardShortcuts}
                >
                  <IconRefresh size={18} />
                  Reset all
                </button>
              </div>

              {KEYBOARD_SHORTCUT_ACTIONS.map((shortcutAction) => {
                const shortcut = keyboardShortcuts[shortcutAction.id];
                const isListening = listeningShortcut === shortcutAction.id;

                return (
                  <div className={styles.shortcutRow} key={shortcutAction.id}>
                    <span className={styles.toggleDescription}>
                      <strong>{shortcutAction.label}</strong>
                      <span>{shortcutAction.description}</span>
                    </span>
                    <div className={styles.shortcutControls}>
                      <button
                        className={`${styles.shortcutCapture} ${isListening ? styles.shortcutCaptureListening : ""}`}
                        type="button"
                        aria-pressed={isListening}
                        onClick={() => setListeningShortcut(shortcutAction.id)}
                        onKeyDown={(event) => handleShortcutCapture(event, shortcutAction.id)}
                        onBlur={() => {
                          if (isListening) setListeningShortcut(null);
                        }}
                      >
                        {isListening ? "Press shortcut..." : formatKeyboardShortcut(shortcut)}
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => resetKeyboardShortcut(shortcutAction.id)}
                      >
                        Reset
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        disabled={!shortcut}
                        onClick={() => setKeyboardShortcut(shortcutAction.id, null)}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {activeTab === "window" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="Style settings">
          <section className={styles.card} aria-labelledby="theme-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="theme-settings-title">Themes</h2>
                <p>Choose the app theme or import a local CSS override.</p>
              </div>
              <IconPalette className={styles.cardIcon} size={22} />
            </div>

            <div className={styles.themeGrid}>
              {APP_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  className={`${styles.themeButton} ${appTheme === theme.id ? styles.themeButtonActive : ""}`}
                  type="button"
                  aria-pressed={appTheme === theme.id}
                  onClick={() => handleThemeSelect(theme.id)}
                >
                  <span className={styles.themeSwatch} aria-hidden="true">
                    {THEME_SWATCH_COLORS[theme.id].map((color) => (
                      <span
                        key={color}
                        className={styles.themeSwatchSegment}
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className={styles.themeDetails}>
                    <strong>{theme.label}</strong>
                    {instanceTheme === theme.id && (
                      <small className={styles.instanceThemeBadge}>Instance default</small>
                    )}
                  </span>
                </button>
              ))}
            </div>

            <div className={styles.settingActionRow}>
              <span className={styles.toggleDescription}>
                <strong>Instance theme</strong>
                <span>
                  {instanceTheme
                    ? `This server's default is "${
                        APP_THEMES.find((theme) => theme.id === instanceTheme)?.label ?? instanceTheme
                      }". It applies to sign-in and to anyone who has not chosen their own.`
                    : "The admin has not set an instance theme; the built-in default applies."}
                  {hasPersonalTheme()
                    ? " You have your own theme, which wins inside the app."
                    : " You are following it now."}
                </span>
              </span>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={!hasPersonalTheme()}
                onClick={clearPersonalTheme}
              >
                Use instance theme
              </button>
            </div>

            {appTheme === "glass" && (
              <div className={styles.themeSettingsPanel}>
                <label className={styles.themeSliderRow}>
                  <span className={styles.themeSliderLabel}>
                    <strong>Glass depth</strong>
                    <span>{glassThemeSettings.intensity}%</span>
                  </span>
                  <input
                    className={styles.themeRange}
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={glassThemeSettings.intensity}
                    onChange={(event) => setGlassThemeSettings({
                      intensity: Number(event.target.value),
                    })}
                  />
                </label>
              </div>
            )}

            {appTheme === "matrix" && (
              <div className={styles.themeSettingsPanel}>
                <label className={styles.themeSliderRow}>
                  <span className={styles.themeSliderLabel}>
                    <strong>Rain speed</strong>
                    <span>{matrixThemeSettings.rainSpeed}%</span>
                  </span>
                  <input
                    className={styles.themeRange}
                    type="range"
                    min="25"
                    max="300"
                    step="5"
                    value={matrixThemeSettings.rainSpeed}
                    onChange={(event) => setMatrixThemeSettings({
                      rainSpeed: Number(event.target.value),
                    })}
                  />
                </label>

                <label className={styles.themeSliderRow}>
                  <span className={styles.themeSliderLabel}>
                    <strong>Worn artwork</strong>
                    <span>{matrixThemeSettings.mediaAging}%</span>
                  </span>
                  <input
                    className={styles.themeRange}
                    type="range"
                    min="0"
                    max="200"
                    step="5"
                    value={matrixThemeSettings.mediaAging}
                    onChange={(event) => setMatrixThemeSettings({
                      mediaAging: Number(event.target.value),
                    })}
                  />
                </label>
              </div>
            )}

            <div className={styles.settingActionRow}>
              <span className={styles.toggleDescription}>
                <strong>Custom CSS theme</strong>
                <span>Import a .css file. It is stored with your settings and applied as the Custom CSS theme.</span>
              </span>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={themeImporting}
                onClick={() => void handleImportCustomTheme()}
              >
                <IconFolderOpen size={18} />
                {themeImporting ? "Importing..." : "Import CSS"}
              </button>
            </div>

            {themeError && <p className={styles.error}>{themeError}</p>}
          </section>


          <section className={styles.card} aria-labelledby="behavior-settings-title">
            <div className={styles.compactHeader}>
              <h2 id="behavior-settings-title">Behavior</h2>
            </div>

            <label className={styles.toggleRow}>
              <span className={styles.toggleDescription}>
                <strong>Always show extra controls</strong>
                <span>Keep lyrics and queue visible instead of showing them only on hover.</span>
              </span>
              <input
                className={styles.toggleInput}
                type="checkbox"
                checked={extraPlayerControlsAlwaysVisible}
                onChange={(event) => setExtraPlayerControlsAlwaysVisible(event.target.checked)}
              />
              <span className={styles.toggle} aria-hidden="true" />
            </label>
          </section>
        </div>
      )}

      {activeTab === "api" && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="API settings">
          <section className={styles.card} aria-labelledby="api-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="api-settings-title">API keys</h2>
                <p>
                  {auth.session.authenticated
                    ? "Keys act as your account on this server's HTTP API. Send one as \"Authorization: Bearer odk_…\" and revoke it when the integration is gone."
                    : "API keys are bound to your account. Sign in to create and manage them."}
                </p>
                <p>
                  <a className={styles.docsLink} href="/docs" target="_blank" rel="noreferrer">
                    API documentation →
                  </a>
                </p>
              </div>
              <span className={`${styles.status} ${apiKeys.length > 0 ? styles.connected : ""}`}>
                {auth.session.authenticated
                  ? apiKeys.length > 0
                    ? `${apiKeys.length} active`
                    : "None"
                  : "Signed out"}
              </span>
            </div>

            {!auth.session.authenticated ? (
              <div className={styles.settingsList}>
                <div className={styles.actionRow}>
                  <span className={styles.toggleDescription}>
                    <strong>Sign in required</strong>
                    <span>Keys authenticate as your account, so they can only be managed from a signed-in session.</span>
                  </span>
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={authBusy}
                    onClick={() => void onSignIn()}
                  >
                    <IconLogin size={18} />
                    Sign in
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.settingsList}>
                <div className={styles.localPlaylistsBlock}>
                  <div className={styles.localPlaylistHeader}>
                    <span className={styles.toggleDescription}>
                      <strong>Create a key</strong>
                      <span>Label it for the integration that will use it. The full key is shown once.</span>
                    </span>
                    <div className={styles.localPlaylistCreate}>
                      <input
                        type="text"
                        value={apiKeyLabel}
                        placeholder="Label"
                        aria-label="API key label"
                        maxLength={80}
                        onChange={(event) => setApiKeyLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void handleCreateApiKey();
                        }}
                      />
                      <button
                        className={styles.signInButton}
                        type="button"
                        disabled={apiKeyBusy || !apiKeyLabel.trim()}
                        onClick={() => void handleCreateApiKey()}
                      >
                        <IconKey size={18} />
                        {apiKeyBusy ? "Working..." : "Create key"}
                      </button>
                    </div>
                  </div>

                  {apiKeyError && <p className={styles.error}>{apiKeyError}</p>}

                  {apiKeyCreated && (
                    <div className={styles.apiKeyReveal}>
                      <span className={styles.toggleDescription}>
                        <strong>{apiKeyCreated.label} — copy it now</strong>
                        <span>
                          This is the only time the full key is shown. If it is lost, revoke it and create another.
                        </span>
                      </span>
                      <code className={styles.apiKeySecret}>{apiKeyCreated.key}</code>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => void handleCopyApiKey()}
                      >
                        <IconCopy size={18} />
                        {apiKeyCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  )}
                </div>

                {apiKeys.length > 0 ? (
                  <div className={styles.localPlaylistList}>
                    {apiKeys.map((key) => (
                      <div className={styles.localPlaylistItem} key={key.id}>
                        <div className={styles.localPlaylistTitleRow}>
                          <span className={styles.localPlaylistTitle}>
                            <IconKey size={18} aria-hidden="true" />
                            {key.label}
                          </span>
                          <button
                            className={styles.dangerButton}
                            type="button"
                            disabled={apiKeyBusy}
                            onClick={() => void handleRevokeApiKey(key.id)}
                          >
                            <IconTrash size={18} />
                            Revoke
                          </button>
                        </div>
                        <span className={styles.toggleDescription}>
                          <span>
                            {key.keyPrefix}… · created {new Date(key.createdAt).toLocaleDateString()}
                            {key.lastUsedAt
                              ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                              : " · never used"}
                          </span>
                          <span className={styles.keyStats}>
                            <strong>{key.stats.totalPlays.toLocaleString()}</strong> plays via API
                            {key.stats.playsLast7Days > 0 && (
                              <> · <strong>{key.stats.playsLast7Days.toLocaleString()}</strong> in the last 7 days</>
                            )}
                            {key.stats.lastPlayedAt && (
                              <> · last play {new Date(key.stats.lastPlayedAt).toLocaleString()}</>
                            )}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className={styles.toggleDescription}>
                    <span>No API keys yet.</span>
                  </span>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === "admin" && isAdmin && (
        <div className={styles.tabPanel} role="tabpanel" aria-label="Admin settings">
          {adminError && <p className={styles.error}>{adminError}</p>}
          {adminNotice && <p className={styles.adminNotice}>{adminNotice}</p>}

          <section className={styles.card} aria-labelledby="admin-overview-title">
            <div className={styles.compactHeader}>
              <h2 id="admin-overview-title">Instance overview</h2>
            </div>
            <div className={styles.statPills}>
              <span className={`${styles.status} ${styles.connected}`}>
                {adminOverview?.users ?? "—"} users
              </span>
              <span className={styles.status}>{adminOverview?.admins ?? "—"} admins</span>
              <span className={styles.status}>{adminOverview?.sessions ?? "—"} sessions</span>
              <span className={styles.status}>{adminOverview?.apiKeys ?? "—"} API keys</span>
              <span className={styles.status}>{adminOverview?.cacheEntries ?? "—"} cache entries</span>
              <span className={styles.status}>
                {adminOverview?.imageCacheBytes !== undefined
                  ? formatBytes(adminOverview.imageCacheBytes)
                  : "—"}{' '}
                artwork
              </span>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-users-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="admin-users-title">Users</h2>
                <p>Create accounts, change roles, revoke access, and recover stuck second factors.</p>
              </div>
            </div>

            <div className={styles.settingsList}>
              <div className={styles.localPlaylistsBlock}>
                <div className={styles.localPlaylistHeader}>
                  <span className={styles.toggleDescription}>
                    <strong>Create an account</strong>
                    <span>Credentials go straight to the person — no invite code needed.</span>
                  </span>
                </div>
                <div className={styles.adminCreateGrid}>
                  <input
                    type="email"
                    placeholder="Email"
                    aria-label="New user email"
                    value={newUserEmail}
                    maxLength={254}
                    onChange={(event) => setNewUserEmail(event.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Name (optional)"
                    aria-label="New user name"
                    value={newUserName}
                    maxLength={80}
                    onChange={(event) => setNewUserName(event.target.value)}
                  />
                  <input
                    type="password"
                    placeholder="Password (8+)"
                    aria-label="New user password"
                    value={newUserPassword}
                    maxLength={256}
                    onChange={(event) => setNewUserPassword(event.target.value)}
                  />
                  <CustomSelect<"admin" | "user">
                    label="Role"
                    value={newUserRole}
                    onChange={setNewUserRole}
                    options={[
                      { value: "user", label: "User" },
                      { value: "admin", label: "Admin" },
                    ]}
                  />
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={
                      adminBusy || !newUserEmail.trim() || newUserPassword.length < 8
                    }
                    onClick={handleCreateUser}
                  >
                    <IconUser size={18} />
                    Create account
                  </button>
                </div>
              </div>

              {adminUsers.map((user) => {
                const isSelf =
                  Boolean(auth.session.user?.email) &&
                  auth.session.user?.email === user.email;
                return (
                  <div className={styles.localPlaylistItem} key={user.id}>
                    <div className={styles.localPlaylistTitleRow}>
                      <span className={styles.localPlaylistTitle}>
                        <IconUser size={18} aria-hidden="true" />
                        {user.name}
                        <span
                          className={`${styles.status} ${
                            user.role === "admin" ? styles.connected : ""
                          }`}
                        >
                          {user.role}
                        </span>
                        {user.totpEnabled && <span className={styles.status}>2FA</span>}
                      </span>
                      <CustomSelect<"admin" | "user">
                        label={`Role for ${user.name}`}
                        value={user.role}
                        disabled={adminBusy || isSelf}
                        onChange={(role) => handleRoleChange(user.id, role)}
                        options={[
                          { value: "user", label: "User" },
                          { value: "admin", label: "Admin" },
                        ]}
                      />
                    </div>
                    <span className={styles.toggleDescription}>
                      <span>
                        {user.email ?? "—"} · joined {new Date(user.createdAt).toLocaleDateString()}
                        {user.lastLoginAt
                          ? ` · last active ${new Date(user.lastLoginAt).toLocaleDateString()}`
                          : " · never signed in"}
                      </span>
                    </span>
                    <div className={styles.adminRowActions}>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        disabled={adminBusy}
                        onClick={() => handleRevokeSessions(user.id)}
                      >
                        <IconLogout size={18} />
                        Sign out everywhere
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        disabled={adminBusy || !user.totpEnabled}
                        onClick={() => handleAdminTotpReset(user.id)}
                      >
                        <IconShieldExclamation size={18} />
                        Reset 2FA
                      </button>
                      <button
                        className={styles.dangerButton}
                        type="button"
                        disabled={adminBusy || isSelf}
                        onClick={() => handleDeleteUser(user.id)}
                      >
                        <IconTrash size={18} />
                        {deleteConfirmId === user.id ? "Press again to delete" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-registration-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="admin-registration-title">Account creation</h2>
                <p>
                  Whether visitors on the sign-up page can create an account themselves.
                  Closed means joins happen only through this panel — or an invite code,
                  if one is configured. Existing accounts always keep signing in.
                </p>
              </div>
              <span
                className={`${styles.status} ${
                  adminRegistration?.enabled ? styles.connected : ""
                }`}
              >
                {adminRegistration
                  ? adminRegistration.enabled
                    ? "Open"
                    : "Closed"
                  : "…"}
              </span>
            </div>

            <div className={styles.settingsList}>
              <label className={styles.toggleRow}>
                <span className={styles.toggleDescription}>
                  <strong>Allow self-service sign-up</strong>
                  <span>
                    {adminRegistration?.overridden
                      ? `Overriding ALLOW_REGISTRATION=${adminRegistration.envDefault ? 1 : 0} from the environment.`
                      : `Following ALLOW_REGISTRATION=${adminRegistration?.envDefault ? 1 : 0} from the environment.`}
                    {adminRegistration?.inviteCodeRequired
                      ? " An invite code is currently required in addition."
                      : ""}
                  </span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={Boolean(adminRegistration?.enabled)}
                  disabled={adminBusy || !adminRegistration}
                  onChange={(event) => handleToggleRegistration(event.target.checked)}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-oauth-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="admin-oauth-title">Sign-in provider</h2>
                <p>
                  Any OpenID Connect provider — Google, Keycloak, Authentik, and friends.
                  Changes take effect immediately on the sign-in page.
                </p>
              </div>
              <span
                className={`${styles.status} ${
                  adminOAuth?.configured ? styles.connected : ""
                }`}
              >
                {adminOAuth ? (adminOAuth.configured ? "Configured" : "Not configured") : "…"}
              </span>
            </div>

            <div className={styles.settingsList}>
              <div className={styles.adminForm}>
                <label className={styles.adminField}>
                  <span>Provider name</span>
                  <input
                    type="text"
                    value={oauthForm.providerName}
                    maxLength={40}
                    placeholder="Google"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, providerName: event.target.value }))
                    }
                  />
                </label>
                <label className={styles.adminField}>
                  <span>Discovery URL</span>
                  <input
                    type="url"
                    value={oauthForm.discoveryUrl}
                    placeholder="https://idp.example.com/.well-known/openid-configuration"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, discoveryUrl: event.target.value }))
                    }
                  />
                </label>
                <label className={styles.adminField}>
                  <span>Client ID</span>
                  <input
                    type="text"
                    value={oauthForm.clientId}
                    maxLength={1024}
                    placeholder="oauth-client-id"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, clientId: event.target.value }))
                    }
                  />
                </label>
                <label className={styles.adminField}>
                  <span>Client secret {adminOAuth?.clientSecretSet && <em>(set — type to replace)</em>}</span>
                  <input
                    type="password"
                    value={oauthForm.clientSecret}
                    maxLength={1024}
                    autoComplete="new-password"
                    placeholder={adminOAuth?.clientSecretSet ? "••••••••••" : "client secret"}
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, clientSecret: event.target.value }))
                    }
                  />
                </label>
                <div className={styles.adminRowActions}>
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={adminBusy || !oauthForm.providerName.trim()}
                    onClick={handleSaveOAuth}
                  >
                    Save provider
                  </button>
                  {adminOAuth?.source === "env" && (
                    <span className={styles.toggleDescription}>
                      <span>Effective values come from the server environment.</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-artwork-title">
            <div className={styles.compactHeader}>
              <h2 id="admin-artwork-title">Artwork storage</h2>
            </div>
            <p className={styles.toggleDescription}>
              Album art and thumbnails are cached once for the whole instance. When the budget
              set under System is reached, the least-played artwork is evicted first; formatting
              drops everything now and reclaims the disk space.
            </p>
            <div className={styles.statPills}>
              <span className={styles.status}>
                {imageCacheReport ? formatBytes(imageCacheReport.stats.usedBytes) : "—"} used
              </span>
              <span className={styles.status}>
                {imageCacheReport ? formatBytes(imageCacheReport.stats.maxBytes) : "—"} budget
              </span>
              <span className={styles.status}>
                {imageCacheReport?.stats.entryCount ?? "—"} images
              </span>
            </div>

            {imageCacheReport && imageCacheReport.images.length > 0 && (
              <div className={styles.settingsList}>
                {imageCacheReport.images.slice(0, 8).map((image) => (
                  <div className={styles.settingRow} key={image.hash}>
                    <span className={styles.toggleDescription}>
                      <strong>{describeArtwork(image.url)}</strong>
                      <span>
                        {formatBytes(image.bytes)} · {image.hitCount} serves · {image.playCount}{" "}
                        plays
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.adminRowActions}>
              <button
                className={styles.dangerButton}
                type="button"
                disabled={adminBusy}
                onClick={() => void handleAdminFormatArtwork()}
              >
                <IconTrash size={18} />
                Format artwork cache
              </button>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-instance-theme-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="admin-instance-theme-title">Instance theme</h2>
                <p>
                  The default look for this whole server — the sign-in page, and
                  every account that has not picked its own theme. Personal choices
                  still win inside the app.
                </p>
              </div>
              <span className={styles.status}>
                {instanceTheme
                  ? APP_THEMES.find((theme) => theme.id === instanceTheme)?.label ?? instanceTheme
                  : "Built-in default"}
              </span>
            </div>

            <div className={styles.themeGrid}>
              {APP_THEMES.filter((theme) => theme.id !== "custom").map((theme) => (
                <button
                  key={theme.id}
                  className={`${styles.themeButton} ${instanceTheme === theme.id ? styles.themeButtonActive : ""}`}
                  type="button"
                  aria-pressed={instanceTheme === theme.id}
                  onClick={() => handleInstanceThemeSelect(theme.id)}
                >
                  <span className={styles.themeSwatch} aria-hidden="true">
                    {THEME_SWATCH_COLORS[theme.id].map((color) => (
                      <span
                        key={color}
                        className={styles.themeSwatchSegment}
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className={styles.themeDetails}>
                    <strong>{theme.label}</strong>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-debug-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="admin-debug-title">Debug</h2>
                <p>
                  Show a cache inspector over every page: which artwork came from
                  our own cache, what the server is holding, and what this browser
                  has stored. Read-only.
                </p>
              </div>
              <span className={styles.status}>
                {debugOverlayEnabled ? "On" : "Off"}
              </span>
            </div>

            <div className={styles.settingsList}>
              <label className={styles.toggleRow}>
                <span className={styles.toggleDescription}>
                  <strong>Show the cache overlay</strong>
                  <span>
                    Follows your account, not the instance — other administrators
                    do not see it. Dismiss it any time from the panel itself.
                  </span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={debugOverlayEnabled}
                  onChange={(event) => setDebugOverlayEnabled(event.target.checked)}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="admin-danger-title">
            <div className={styles.compactHeader}>
              <h2 id="admin-danger-title">Danger zone</h2>
            </div>
            <div className={styles.settingsList}>
              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Reset all app data</strong>
                  <span>
                    Clears every account's durable settings and the cache, and signs everyone
                    out except you. Accounts, playlists, likes, and API keys are kept. Confirmed
                    with your two-step code.
                  </span>
                </span>
              </div>
              {auth.session.totpEnabled ? (
                resetConfirming ? (
                  <div className={styles.adminRowActions}>
                    <input
                      className={styles.adminCodeInput}
                      type="text"
                      inputMode="numeric"
                      placeholder="123456 or a backup code"
                      aria-label="Two-step code"
                      value={resetTotpCode}
                      maxLength={11}
                      onChange={(event) =>
                        setResetTotpCode(event.target.value.replace(/[^\d\s-]/g, ""))
                      }
                    />
                    <button
                      className={styles.dangerButton}
                      type="button"
                      disabled={adminBusy || resetTotpCode.trim().length < 6}
                      onClick={handleResetAppData}
                    >
                      Confirm reset
                    </button>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      disabled={adminBusy}
                      onClick={() => {
                        setResetConfirming(false);
                        setResetTotpCode("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className={styles.dangerButton}
                    type="button"
                    disabled={adminBusy}
                    onClick={handleResetAppData}
                  >
                    <IconTrash size={18} />
                    Reset all app data
                  </button>
                )
              ) : (
                <p className={styles.error}>
                  Enable two-step verification in About → Security before using the danger zone.
                </p>
              )}
            </div>
          </section>
        </div>
      )}

      {showCustomThemeWarning && (
        <div
          className={styles.modalOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCustomThemeWarning(false);
          }}
        >
          <section
            className={styles.warningModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-theme-warning-title"
          >
            <div className={styles.warningIcon} aria-hidden="true">
              <IconShieldExclamation size={24} />
            </div>
            <div className={styles.warningContent}>
              <h2 id="custom-theme-warning-title">Import custom CSS theme</h2>
              <p>
                Custom CSS themes are not scanned for malware by OpenDeck.
                They could contain malicious or unsafe content. Only import CSS files from
                sources you trust.
              </p>
            </div>
            <div className={styles.warningActions}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setShowCustomThemeWarning(false)}
              >
                Cancel
              </button>
              <button
                className={styles.signInButton}
                type="button"
                onClick={() => void handleConfirmCustomThemeImport()}
              >
                <IconFolderOpen size={18} />
                Choose CSS file
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

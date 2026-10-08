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
  IconBrandLastfm,
  IconBug,
  IconChevronDown,
  IconCoffee,
  IconFolder,
  IconFolderPlus,
  IconFolderOpen,
  IconLogin,
  IconLogout,
  IconMap,
  IconPalette,
  IconRefresh,
  IconShieldExclamation,
  IconStar,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import {
  clearCache,
  DEFAULT_CACHE_SIZE_GB,
  getCacheStats,
  setCacheMaxBytes,
  type CacheStats,
} from "../../internal/cache";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import {
  setExtraPlayerControlsAlwaysVisible,
  useExtraPlayerControlsAlwaysVisible,
} from "../settings/playerControls";
import { setPaperPcMode, usePaperPcMode } from "../settings/paperPcMode";
import {
  APP_THEMES,
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
import { LastFmService, type LastFmAuthStart, type LastFmSessionStatus } from "../../player/LastFm";
import {
  setLastFmScrobblingEnabled,
  useLastFmScrobblingEnabled,
} from "../settings/lastfm";
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
import { GITHUB_REPOSITORY_URL } from "../errors/errorManager";
import { useAuth } from "../../auth/authClient";
import {
  pickLocalAudioDirectory,
  pickLocalAudioFiles,
} from "../../player/localFiles";
import styles from "./SettingsPage.module.css";

const KOFI_URL = "https://ko-fi.com/totally2late";
const USERJOT_FEEDBACK_URL = "https://justanothermusicclient.userjot.com/";
const USERJOT_ROADMAP_URL = "https://justanothermusicclient.userjot.com/roadmap";

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

type SettingsTab = "about" | "system" | "shortcuts" | "window" | "plugins";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "about", label: "About" },
  { id: "system", label: "System" },
  { id: "window", label: "Style" },
  { id: "plugins", label: "Plugins" },
  { id: "shortcuts", label: "Shortcuts" },
];

const THEME_SWATCH_COLORS: Record<AppTheme, string[]> = {
  dark: ["#070707", "#181818", "#ff0033"],
  light: ["#f4f5f7", "#ffffff", "#d7193f"],
  glass: ["#f4e9ff", "#5e4a67", "#f6c37a"],
  matrix: ["#020803", "#041208", "#4dff77"],
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
  onDeleteAllAppData: () => Promise<void>;
}

export function SettingsPage({
  libraryController,
  libraryState,
  onRestartOnboarding,
  onSignIn,
  onDeleteAllAppData,
}: SettingsPageProps) {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheSizeGb, setCacheSizeGb] = useState(DEFAULT_CACHE_SIZE_GB.toString());
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [resetSettingsConfirming, setResetSettingsConfirming] = useState(false);
  const [resetSettingsBusy, setResetSettingsBusy] = useState(false);
  const [resetSettingsError, setResetSettingsError] = useState<string | null>(null);
  const [localPlaylistName, setLocalPlaylistName] = useState("");
  const [localPlaylistPathInputs, setLocalPlaylistPathInputs] = useState<Record<string, string>>({});
  const [localPlaylistError, setLocalPlaylistError] = useState<string | null>(null);
  const [localPlaylistBrowsingId, setLocalPlaylistBrowsingId] = useState<string | null>(null);
  const [lastFmSession, setLastFmSession] = useState<LastFmSessionStatus | null>(null);
  const [lastFmAuth, setLastFmAuth] = useState<LastFmAuthStart | null>(null);
  const [lastFmBusy, setLastFmBusy] = useState(false);
  const [lastFmError, setLastFmError] = useState<string | null>(null);
  const [themeImporting, setThemeImporting] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [showCustomThemeWarning, setShowCustomThemeWarning] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("about");
  const [listeningShortcut, setListeningShortcut] = useState<KeyboardShortcutAction | null>(null);
  const keyboardShortcuts = useKeyboardShortcuts();
  const paperPcMode = usePaperPcMode();
  const appTheme = useAppTheme();
  const glassThemeSettings = useGlassThemeSettings();
  const matrixThemeSettings = useMatrixThemeSettings();
  const extraPlayerControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();
  const lastFmScrobblingEnabled = useLastFmScrobblingEnabled();
  const auth = useAuth();
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
  const youtubeLinked = auth.session.youtubeLinked || Boolean(isSignedIn);
  const authPrompt = libraryState.authPrompt;
  const accountPlaybackEnabled = authenticatedStreaming && youtubeScrobbling;
  const activeTabIndex = Math.max(0, SETTINGS_TABS.findIndex((tab) => tab.id === activeTab));
  const authBusy = libraryState.status === "restoring"
    || libraryState.status === "authorizing"
    || libraryState.status === "loading";

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

  useEffect(() => {
    let active = true;
    void LastFmService.getSession()
      .then((session) => {
        if (active) setLastFmSession(session);
      })
      .catch((error) => {
        if (active) {
          setLastFmError(error instanceof Error ? error.message : "Unable to load Last.fm connection.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!resetSettingsConfirming) return undefined;
    const timeout = window.setTimeout(() => setResetSettingsConfirming(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [resetSettingsConfirming]);

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

  const handleClearAllSettings = async () => {
    setResetSettingsError(null);
    if (!resetSettingsConfirming) {
      setResetSettingsConfirming(true);
      return;
    }

    setResetSettingsBusy(true);
    try {
      await onDeleteAllAppData();
      window.location.reload();
    } catch {
      setResetSettingsError("Unable to delete all app data.");
      setResetSettingsBusy(false);
      setResetSettingsConfirming(false);
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

  const handleStartLastFmAuth = async () => {
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      const auth = await LastFmService.startAuth();
      setLastFmAuth(auth);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to start Last.fm sign-in.");
    } finally {
      setLastFmBusy(false);
    }
  };

  const handleFinishLastFmAuth = async () => {
    if (!lastFmAuth) return;
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      const session = await LastFmService.completeAuth(lastFmAuth.token);
      setLastFmSession(session);
      setLastFmAuth(null);
      setLastFmScrobblingEnabled(true);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to finish Last.fm sign-in.");
    } finally {
      setLastFmBusy(false);
    }
  };

  const handleDisconnectLastFm = async () => {
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      await LastFmService.disconnect();
      setLastFmSession(null);
      setLastFmAuth(null);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to disconnect Last.fm.");
    } finally {
      setLastFmBusy(false);
    }
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
      setPluginError("Unable to rediscover downloads.");
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

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Application</span>
        <h1>Settings</h1>
        <p>Manage account, system, and window behavior.</p>
      </div>

      <div className={styles.githubActions}>
        <button
          className={styles.githubButton}
          type="button"
          onClick={() => openExternal(KOFI_URL)}
        >
          <IconCoffee size={18} />
          Buy me a coffee
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => openExternal(GITHUB_REPOSITORY_URL)}
        >
          <IconStar size={18} />
          Star on GitHub
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => openExternal(USERJOT_ROADMAP_URL)}
        >
          <IconMap size={18} />
          Suggest a feature
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => openExternal(USERJOT_FEEDBACK_URL)}
        >
          <IconBug size={18} />
          Report issue
        </button>
      </div>

      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Settings categories"
        style={{
          "--active-tab-offset": `${activeTabIndex * 100}%`,
          "--tab-count": SETTINGS_TABS.length,
        } as CSSProperties}
      >
        {SETTINGS_TABS.map((tab) => (
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
                    ? "Sign in with Google to unlock your library, playlists, and settings."
                    : youtubeLinked
                      ? "Signed in — YouTube Music account connected."
                      : "Signed in — connect your YouTube Music account."}
                </p>
              </div>
              <span className={`${styles.status} ${isSignedIn || youtubeLinked ? styles.connected : ""}`}>
                {isSignedIn && youtubeLinked ? "Connected" : googleUser ? "Google only" : "Signed out"}
              </span>
            </div>

            <div className={styles.accountRow}>
              {account?.artworkUrl ? (
                <img className={styles.avatar} src={account.artworkUrl} alt="" />
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
                    ? "Use your Google account to sign in."
                    : youtubeLinked
                      ? account?.name
                        ? `YouTube Music: ${account.name}`
                        : "Your library and listening history are available."
                    : "Connect YouTube Music to load your library."}
                </span>
              </div>

              {!googleUser ? (
                <button
                  className={styles.signInButton}
                  type="button"
                  disabled={authBusy}
                  onClick={() => void onSignIn()}
                >
                  <IconLogin size={18} />
                  {authBusy ? "Connecting..." : "Sign in with Google"}
                </button>
              ) : !youtubeLinked ? (
                <button
                  className={styles.signInButton}
                  type="button"
                  disabled={authBusy}
                  onClick={() => void onSignIn()}
                >
                  <IconLogin size={18} />
                  {authBusy ? "Waiting for Google..." : "Connect YouTube Music"}
                </button>
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
                    Open <u>{authPrompt.verificationUrl}</u> and enter the code
                    {authPrompt.userCode ? ` ${authPrompt.userCode}` : " shown below"}
                    {authPrompt.expiresInSec ? ` (expires in ${Math.ceil(authPrompt.expiresInSec / 60)} min)` : ""}.
                  </span>
                </span>
                {authPrompt.userCode && (
                  <strong className={styles.status} style={{ fontSize: 18 }}>
                    {authPrompt.userCode}
                  </strong>
                )}
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

          <section className={styles.card} aria-labelledby="lastfm-settings-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="lastfm-settings-title">Last.fm</h2>
                <p>
                  {lastFmSession
                    ? `Connected as ${lastFmSession.username}`
                    : "Connect Last.fm to scrobble your listening history."}
                </p>
              </div>
              <span className={`${styles.status} ${lastFmSession ? styles.connected : ""}`}>
                {lastFmSession ? "Connected" : "Signed out"}
              </span>
            </div>

            <div className={styles.settingsList}>
              <label className={`${styles.settingRow} ${!lastFmSession ? styles.toggleRowDisabled : ""}`}>
                <span className={styles.toggleDescription}>
                  <strong>Scrobble plays</strong>
                  <span>
                    Send now playing updates and scrobbles after a track reaches the Last.fm listening threshold.
                  </span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={lastFmSession ? lastFmScrobblingEnabled : false}
                  disabled={!lastFmSession}
                  onChange={(event) => setLastFmScrobblingEnabled(event.target.checked)}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Account connection</strong>
                  <span>
                    {lastFmAuth
                      ? "Approve the connection in your browser, then finish it here."
                      : lastFmSession
                        ? "Disconnecting stops future Last.fm updates from this app."
                        : "A browser window will open so you can approve this app on Last.fm."}
                  </span>
                </span>
                {lastFmSession ? (
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleDisconnectLastFm()}
                  >
                    <IconBrandLastfm size={18} />
                    {lastFmBusy ? "Disconnecting..." : "Disconnect"}
                  </button>
                ) : lastFmAuth ? (
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleFinishLastFmAuth()}
                  >
                    <IconBrandLastfm size={18} />
                    {lastFmBusy ? "Finishing..." : "Finish connection"}
                  </button>
                ) : (
                  <button
                    className={styles.signInButton}
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleStartLastFmAuth()}
                  >
                    <IconBrandLastfm size={18} />
                    {lastFmBusy ? "Opening..." : "Connect Last.fm"}
                  </button>
                )}
              </div>

              {lastFmError && <p className={styles.error}>{lastFmError}</p>}
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


              <label className={styles.settingRow}>
                <span className={styles.toggleDescription}>
                  <strong>Potato PC mode</strong>
                  <span>Disables animations, blur effects, and the animated star background.</span>
                </span>
                <input
                  className={styles.toggleInput}
                  type="checkbox"
                  checked={paperPcMode}
                  onChange={(event) => setPaperPcMode(event.target.checked)}
                />
                <span className={styles.toggle} aria-hidden="true" />
              </label>

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

              {cacheError && <p className={styles.error}>{cacheError}</p>}

              <div className={styles.actionRow}>
                <span className={styles.toggleDescription}>
                  <strong>Delete all app data</strong>
                  <span>Reset settings, cache, account, queue, tabs, onboarding, and local data.</span>
                </span>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={resetSettingsBusy}
                  onClick={() => void handleClearAllSettings()}
                >
                  <IconTrash size={18} />
                  {resetSettingsBusy
                    ? "Deleting..."
                    : resetSettingsConfirming
                      ? "Press again to confirm"
                      : "Delete everything"}
                </button>
              </div>

              {resetSettingsError && <p className={styles.error}>{resetSettingsError}</p>}
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
                          <span>Downloads keep the best container YouTube exposes for the selected quality.</span>
                        </span>
                        <CustomSelect<AudioQuality>
                          label="Download quality"
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
                          <strong>Rediscover downloads</strong>
                          <span>Re-check stored downloads against browser storage and drop entries whose audio is gone.</span>
                        </span>
                        <button
                          className={styles.secondaryButton}
                          type="button"
                          disabled={pluginBusy}
                          onClick={() => void handleRediscoverDownloads()}
                        >
                          <IconRefresh size={18} />
                          Rediscover
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
                  </span>
                </button>
              ))}
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
                Custom CSS themes are not scanned for malware by Just Another Music Client.
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

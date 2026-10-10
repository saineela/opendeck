import { useCallback, useEffect, useRef, useState } from "react";
import type { Album, Artist, Playlist, SearchResults, Track } from "../datasource/types";
import { useDisableContextMenu } from "./hooks/useDisableContextMenu";
import { HomePage } from "./pages/HomePage";
import { AlbumView } from "./pages/AlbumView";
import { PlaylistView } from "./pages/PlaylistView";
import { SearchResultsPage } from "./pages/SearchResultsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { RecommendationsPage } from "./pages/RecommendationsPage";
import { LyricsView } from "./pages/LyricsView";
import { ArtistView } from "./pages/ArtistView";
import { SearchOverlay } from "./components/SearchOverlay";
import { TrackContextMenuProvider } from "./components/TrackContextMenu";
import { PlaylistContextMenuProvider } from "./components/PlaylistContextMenu";
import { ArtistNavigationProvider } from "./components/ArtistLinks";
import { TitleBar } from "./components/TitleBar";
import { PlayerBar } from "./components/player/PlayerBar";
import { QueuePanel } from "./components/player/QueuePanel";
import { Layout } from "./components/Layout";
import type { Tab, TabViewState } from "./types/tab";
import {
  libraryController,
  playerController,
  searchController,
  tabManager,
  useLibraryState,
  usePlayerSession,
  usePlayerState,
} from "../player/playerStore";
import styles from "./App.module.css";
import { loadAppSession, saveAppSession } from "../player/appSession";
import { useMediaSession } from "../player/useMediaSession";
import { playerUIStore, usePlayerUIState } from "./stores/playerUIStore";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { ErrorToastViewport } from "./components/ErrorToastViewport";
import {
  getAppSetting,
  removeAppSetting,
  setAppSetting,
} from "../internal/appSettings";
import { refreshAuthSession, getAuthSnapshot, useAuth } from "../auth/authClient";
import {
  pushSupported,
  registerServiceWorker,
} from "../internal/recommendationsClient";
import { LoginPage } from "./pages/LoginPage";
import {
  Onboarding,
  OnboardingCompleteToast,
  OnboardingWelcome,
  type OnboardingStep,
} from "./components/Onboarding";

import {
  eventMatchesShortcut,
  useKeyboardShortcuts,
  type KeyboardShortcutAction,
} from "./settings/keyboardShortcuts";
import { hydratePlaybackSettings } from "../player/playbackSettings";
import { appErrorManager } from "./errors/errorManager";
const restoredSession = loadAppSession();
const LOADING_SCREEN_FADE_MS = 80;
const LOADING_SCREEN_MAX_MS = 4000;
const ONBOARDING_COMPLETE_KEY = "yt-music-dock:onboarding-complete";
const ONBOARDING_COMPLETE_SETTING_KEY = "onboardingComplete";
const LOADING_SCREEN_MIN_MS = 1000;
const MOUSE_BACK_BUTTON = 3;
const MOUSE_FORWARD_BUTTON = 4;
const SLEEP_RECOVERY_TIMER_INTERVAL_MS = 15000;
const SLEEP_RECOVERY_TIMER_DRIFT_MS = 60000;
const TAB_SHORTCUT_ACTIONS: KeyboardShortcutAction[] = [
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "tab9",
];

/** Tabs outside the player's music-tab rotation (no queue, no back-stack). */
function isUtilityTab(tab: Tab): boolean {
  return tab.view === "settings" || tab.view === "history" || tab.view === "recommendations";
}

function getNavigationState(tab: Tab): TabViewState | null {
  // Explicit union checks (not isUtilityTab) so tab.view narrows.
  if (tab.view === "settings" || tab.view === "history" || tab.view === "recommendations") return null;

  return {
    title: tab.title,
    view: tab.view,
    album: tab.album,
    artist: tab.artist,
    playlist: tab.playlist,
    searchQuery: tab.searchQuery,
    searchResults: tab.searchResults,
    mixedSearchResults: tab.mixedSearchResults,
    searchLoading: tab.searchLoading,
  };
}

function getNavigationKey(state: TabViewState): string {
  switch (state.view) {
    case "album":
      return `album:${state.album?.id ?? ""}`;
    case "artist":
      return `artist:${state.artist?.id ?? state.artist?.name ?? ""}`;
    case "playlist":
      return `playlist:${state.playlist?.id ?? ""}`;
    case "search":
      return `search:${state.searchQuery ?? ""}`;
    case "home":
      return "home";
  }
}

function applyNavigationState(tab: Tab, state: TabViewState): Tab {
  return {
    ...tab,
    title: state.title,
    view: state.view,
    album: state.album,
    artist: state.artist,
    playlist: state.playlist,
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    mixedSearchResults: state.mixedSearchResults,
    searchLoading: state.searchLoading,
  };
}

function stripNavigationHistory(tab: Tab): Tab {
  const { navigationHistory, ...sessionTab } = tab;
  void navigationHistory;
  return sessionTab;
}



function readLocalOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveLocalOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
  } catch {
    // Durable app settings are the source of truth.
  }
}

function clearLocalOnboardingComplete(): void {
  try {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
  } catch {
    // Durable app settings are the source of truth.
  }
}

async function hasStoredYoutubeSession(): Promise<boolean> {
  const session = await refreshAuthSession();
  return session.authenticated && session.youtubeLinked;
}

export default function App() {
  useDisableContextMenu();
  const auth = useAuth();
  const libraryState = useLibraryState();
  const playerState = usePlayerState();
  const playerSession = usePlayerSession();
  const playerUIState = usePlayerUIState();
  const keyboardShortcuts = useKeyboardShortcuts();

  const [tabs, setTabs] = useState<Tab[]>(
    () => restoredSession?.tabs.map(stripNavigationHistory) ?? [{ id: "1", view: "home" }],
  );
  const [activeTabId, setActiveTabId] = useState(
    () => restoredSession?.activeTabId ?? "1",
  );
  const [nextTabId, setNextTabId] = useState(
    () => restoredSession?.nextTabId ?? 2,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [queuePanelWidth, setQueuePanelWidth] = useState(340);
  const [loadingScreenState, setLoadingScreenState] = useState<"visible" | "leaving" | "hidden">("visible");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(() =>
    readLocalOnboardingComplete() ? true : null
  );
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null);
  const [showQueueMounted, setShowQueueMounted] = useState(false);
  const [onboardingFirstTabId, setOnboardingFirstTabId] = useState(activeTabId);
  const [onboardingSecondTabId, setOnboardingSecondTabId] = useState<string | null>(null);
  const [, setOnboardingSearchQuery] = useState("");
  const [showOnboardingComplete, setShowOnboardingComplete] = useState(false);
  const [showOnboardingWelcome, setShowOnboardingWelcome] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hydratePlaybackSettings().then((settings) => {
      if (cancelled) return;
      tabManager.applyPlaybackSettings(settings);
    });

    return () => {
      cancelled = true;
    };
  }, []);
  const [isExpandedPlayerBar,setIsExpandedPlayerBar]=  useState(false)
  // Which top-level route the shell is on (the app itself is "/", the
  // branded sign-in page is "/login"); no router — pushState + popstate.
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = (): void => setRoutePath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigateTo = useCallback((to: string, replace = false): void => {
    if (replace) window.history.replaceState({}, "", to);
    else window.history.pushState({}, "", to);
    setRoutePath(to);
  }, []);
  // The app is gated: without an account session the only surface that
  // exists is the branded sign-in page. Keep the URL honest so reloads,
  // deep links, and the back button all agree with what is on screen.
  useEffect(() => {
    if (auth.status === "signed-out" && routePath !== "/login") {
      navigateTo("/login", true);
    }
  }, [auth.status, navigateTo, routePath]);
  const loadingScreenDismissedRef = useRef(false);
  const loadingScreenStartedAtRef = useRef(performance.now());
  const lastErrorNotificationRef = useRef<string | null>(null);
  const sessionStateRef = useRef({ tabs, activeTabId, nextTabId });
  const sleepRecoveryLastTickRef = useRef(Date.now());
  const sleepRecoveryReloadingRef = useRef(false);
  sessionStateRef.current = { tabs, activeTabId, nextTabId };
  const persistAppSession = useCallback(() => {
    const current = sessionStateRef.current;
    saveAppSession({
      version: 1,
      tabs: current.tabs.map((tab) => ({
        ...stripNavigationHistory(tab),
        searchLoading: false,
      })),
      activeTabId: current.activeTabId,
      nextTabId: current.nextTabId,
      player: tabManager.exportSession(),
    });
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isQueuePanelOpen = activeTab?.isQueueOpen ?? false;
  const canNavigateBack = (activeTab?.navigationHistory?.back.length ?? 0) > 0;
  const canNavigateForward = (activeTab?.navigationHistory?.forward.length ?? 0) > 0;

  const dismissLoadingScreen = useCallback(() => {
    if (loadingScreenDismissedRef.current) return;

    loadingScreenDismissedRef.current = true;
    setLoadingScreenState("leaving");
    window.setTimeout(() => {
      setLoadingScreenState("hidden");
    }, LOADING_SCREEN_FADE_MS);
  }, []);

  const markOnboardingComplete = useCallback((showCompleteToast: boolean) => {
    saveLocalOnboardingComplete();
    setOnboardingComplete(true);
    setOnboardingStep(null);
    setShowOnboardingWelcome(false);
    if (showCompleteToast) setShowOnboardingComplete(true);
    void setAppSetting(ONBOARDING_COMPLETE_SETTING_KEY, true);
  }, []);

  useEffect(() => {
    let active = true;

    const loadOnboardingCompletion = async () => {
      if (readLocalOnboardingComplete()) {
        markOnboardingComplete(false);
        return;
      }

      const storedComplete = await getAppSetting<boolean>(ONBOARDING_COMPLETE_SETTING_KEY);
      if (!active) return;

      if (storedComplete === true) {
        markOnboardingComplete(false);
        return;
      }

      if (await hasStoredYoutubeSession()) {
        if (!active) return;
        markOnboardingComplete(false);
        return;
      }

      if (!active) return;
      setOnboardingComplete(false);
      setOnboardingStep("open-search");
      setShowOnboardingWelcome(true);
    };

    void loadOnboardingCompletion();
    return () => {
      active = false;
    };
  }, [markOnboardingComplete]);

  const navigateTab = useCallback((tabId: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const currentState = getNavigationState(tab);
        if (!currentState) return applyNavigationState(tab, nextState);

        const nextTab = applyNavigationState(tab, nextState);
        if (getNavigationKey(currentState) === getNavigationKey(nextState)) {
          return nextTab;
        }

        return {
          ...nextTab,
          navigationHistory: {
            back: [...(tab.navigationHistory?.back ?? []), currentState],
            forward: [],
          },
        };
      })
    );
  }, []);

  const updateSearchTab = useCallback((tabId: string, query: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;

        const updateHistoryState = (state: TabViewState) =>
          state.view === "search" && state.searchQuery === query
            ? nextState
            : state;
        const navigationHistory = tab.navigationHistory
          ? {
              back: tab.navigationHistory.back.map(updateHistoryState),
              forward: tab.navigationHistory.forward.map(updateHistoryState),
            }
          : undefined;

        if (tab.searchQuery !== query) {
          return {
            ...tab,
            navigationHistory,
          };
        }

        return {
          ...applyNavigationState(tab, nextState),
          navigationHistory,
        };
      })
    );
  }, []);

  const handleNavigateBack = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const back = tab.navigationHistory?.back ?? [];
        if (!currentState || back.length === 0) return tab;

        const previousState = back[back.length - 1];
        const nextTab = applyNavigationState(tab, previousState);
        return {
          ...nextTab,
          navigationHistory: {
            back: back.slice(0, -1),
            forward: [currentState, ...(tab.navigationHistory?.forward ?? [])],
          },
        };
      })
    );
  }, [activeTabId]);

  const handleNavigateForward = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const forward = tab.navigationHistory?.forward ?? [];
        if (!currentState || forward.length === 0) return tab;

        const nextState = forward[0];
        const nextTab = applyNavigationState(tab, nextState);
        return {
          ...nextTab,
          navigationHistory: {
            back: [...(tab.navigationHistory?.back ?? []), currentState],
            forward: forward.slice(1),
          },
        };
      })
    );
  }, [activeTabId]);

  const setIsQueuePanelOpen = useCallback(
    (open: boolean) => {
      setTabs((prevTabs) =>
        prevTabs.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, isQueueOpen: open }
            : tab
        )
      );
    },
    [activeTabId],
  );

  useMediaSession(playerState, playerController);

  const activeViewKey = [
    activeTabId,
    activeTab?.view,
    activeTab?.album?.id,
    activeTab?.artist?.id,
    activeTab?.playlist?.id,
    activeTab?.searchQuery,
  ].filter(Boolean).join(":");

  const handleNavigateHome = () => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "home",
    });
  };

  useEffect(() => {
    void libraryController.initialize();
  }, []);

  useEffect(() => {
    // Keep the Web Push service worker registered on every launch so a device
    // that already granted notification permission keeps receiving
    // recommendation pushes without opening the Recommendations tab.
    if (!pushSupported()) return;
    if (Notification.permission !== "granted") return;
    void registerServiceWorker().catch(() => {
      // Best-effort: push stays off if registration fails (e.g. no HTTPS).
    });
  }, []);

  useEffect(() => {
    if (libraryState.status !== "error" || !libraryState.error) return;
    const message = libraryState.error;
    const key = `library:${message}`;
    if (lastErrorNotificationRef.current === key) return;
    lastErrorNotificationRef.current = key;
    appErrorManager.report(message, {
      title: "YouTube Music sign-in or library sync failed",
    });
  }, [libraryState.error, libraryState.status]);

  useEffect(() => {
    if (playerState.status !== "error" || !playerState.error) return;
    const message = playerState.error;
    const key = `playback:${message}`;
    if (lastErrorNotificationRef.current === key) return;
    lastErrorNotificationRef.current = key;
    appErrorManager.report(message, {
      title: "Playback failed",
    });
  }, [playerState.error, playerState.status]);

  useEffect(() => {
    const elapsed = performance.now() - loadingScreenStartedAtRef.current;
    const remainingMaximum = Math.max(0, LOADING_SCREEN_MAX_MS - LOADING_SCREEN_FADE_MS - elapsed);
    const maxTimer = window.setTimeout(dismissLoadingScreen, remainingMaximum);

    return () => {
      window.clearTimeout(maxTimer);
    };
  }, [dismissLoadingScreen]);

  useEffect(() => {
    const hasRenderableLibrary = Boolean(libraryState.library);
    if (
      !hasRenderableLibrary
      && (libraryState.status === "restoring" || libraryState.status === "loading")
    ) {
      return;
    }

    let cancelled = false;
    let fadeTimer: number | undefined;

    const finishStartup = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled || loadingScreenDismissedRef.current) return;

      const elapsed = performance.now() - loadingScreenStartedAtRef.current;
      const remainingMinimum = Math.max(0, LOADING_SCREEN_MIN_MS - elapsed);
      fadeTimer = window.setTimeout(() => {
        if (cancelled || loadingScreenDismissedRef.current) return;

        dismissLoadingScreen();
      }, remainingMinimum);
    };

    void finishStartup();
    return () => {
      cancelled = true;
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [dismissLoadingScreen, libraryState.library, libraryState.status]);

  useEffect(() => {
    window.addEventListener("beforeunload", persistAppSession);
    return () => {
      window.removeEventListener("beforeunload", persistAppSession);
      persistAppSession();
    };
  }, [persistAppSession]);

  useEffect(() => {
    persistAppSession();
  }, [activeTabId, nextTabId, persistAppSession, playerSession, tabs]);


  useEffect(() => {
    sleepRecoveryLastTickRef.current = Date.now();

    const resetSleepTimerOnVisible = () => {
      if (document.visibilityState === "visible") {
        sleepRecoveryLastTickRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", resetSleepTimerOnVisible);

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - sleepRecoveryLastTickRef.current;
      sleepRecoveryLastTickRef.current = now;

      if (
        elapsed < SLEEP_RECOVERY_TIMER_INTERVAL_MS + SLEEP_RECOVERY_TIMER_DRIFT_MS
        || document.visibilityState === "hidden"
        || sleepRecoveryReloadingRef.current
      ) {
        return;
      }

      sleepRecoveryReloadingRef.current = true;
      persistAppSession();
      window.location.reload();
    }, SLEEP_RECOVERY_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", resetSleepTimerOnVisible);
    };
  }, [persistAppSession]);

  useEffect(() => {
    const tabId = tabManager.getActivePlayerId();
    if (!tabId) return;

    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === tabId && !isUtilityTab(tab)
          ? { ...tab, title: playerState.currentTrack?.title }
          : tab
      )
    );
  }, [playerState.currentTrack, playerState.status]);

  useEffect(() => {
    if (!playerState.currentTrack && playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
    }
  }, [playerState.currentTrack, playerUIState.isLyricsOpen]);

  const handleNavigateAlbum = (album: Album) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "album",
      album,
    });
  };

  const handleNavigateArtist = (artist: Artist, openInNewTab = false) => {
    playerUIStore.setLyricsOpen(false);
    if (!artist.id) {
      const fallbackToSearch = () => handleSearch(artist.name, openInNewTab);
      void searchController.search(artist.name)
        .then((results) => {
          const normalizedName = artist.name.trim().toLocaleLowerCase();
          const resolved = results.artists.find(
            (candidate) => candidate.name.trim().toLocaleLowerCase() === normalizedName,
          ) ?? results.artists.find((candidate) => {
            const candidateName = candidate.name.trim().toLocaleLowerCase();
            return candidateName.includes(normalizedName)
              || normalizedName.includes(candidateName);
          }) ?? results.artists[0];

          if (resolved) {
            handleNavigateArtist(resolved, openInNewTab);
            return;
          }

          fallbackToSearch();
        })
        .catch(fallbackToSearch);
      return;
    }
    if (openInNewTab) {
      const newId = nextTabId.toString();
      tabManager.createTab(newId);
      void tabManager.setActive(newId);
      setTabs((prevTabs) => [
        ...prevTabs,
        { id: newId, view: "artist", artist, title: artist.name },
      ]);
      setActiveTabId(newId);
      setNextTabId((currentId) => currentId + 1);
      return;
    }

    navigateTab(activeTabId, {
      view: "artist",
      artist,
      title: artist.name,
    });
  };

  const handleConnectionRestored = async () => {
    await libraryController.recoverConnection();
  };

  const handleNavigatePlaylist = (playlist: Playlist) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "playlist",
      playlist,
    });
  };

  const createTab = () => {
    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    void tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
    if (onboardingStep === "new-tab") {
      setOnboardingSecondTabId(newId);
      setOnboardingSearchQuery("");
      setOnboardingStep("type-second");
      setIsSearchOpen(true);
    }
  };

  const handleCreateTab = () => createTab();

  const handleSignIn = async () => {
    // No OpenDeck account yet: the branded /login page comes first, then
    // the YouTube Music linking flow can follow if the user wants it.
    if (!getAuthSnapshot().authenticated) {
      navigateTo("/login");
      return;
    }
    await libraryController.signIn();
    if (libraryController.getState().status !== "ready") return;

    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    await tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleAuthSuccess = () => {
    void libraryController.loadAppLibrary();
  };

  const handleSearch = (query: string, openInNewTab: boolean) => {
    playerUIStore.setLyricsOpen(false);
    let targetTabId = activeTabId;

    if (openInNewTab) {
      targetTabId = nextTabId.toString();
      tabManager.createTab(targetTabId);
      void tabManager.setActive(targetTabId);
      setTabs((prevTabs) => [
        ...prevTabs,
        {
          id: targetTabId,
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: true,
        },
      ]);
      setActiveTabId(targetTabId);
      setNextTabId((currentId) => currentId + 1);
    } else {
      navigateTab(targetTabId, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: [],
        mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
        searchLoading: true,
      });
    }

    const searchTabId = targetTabId;
    if (onboardingStep === "type-first") setOnboardingStep("play-first");
    if (onboardingStep === "type-second") setOnboardingStep("play-second");
    const applySearchResults = (results: SearchResults) => {
      updateSearchTab(searchTabId, query, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: results.tracks,
        mixedSearchResults: results,
        searchLoading: false,
      });
    };

    void searchController.search(query, applySearchResults)
      .then(applySearchResults)
      .catch(() => {
        updateSearchTab(searchTabId, query, {
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: false,
        });
      });
  };

  const handleOpenSettings = () => {
    playerUIStore.setLyricsOpen(false);
    const settingsTab = tabs.find((tab) => tab.view === "settings");
    if (settingsTab) {
      setActiveTabId(settingsTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "settings" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleOpenHistory = () => {
    playerUIStore.setLyricsOpen(false);
    const historyTab = tabs.find((tab) => tab.view === "history");
    if (historyTab) {
      setActiveTabId(historyTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [...prevTabs, { id: newId, view: "history" }]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleOpenRecommendations = () => {
    playerUIStore.setLyricsOpen(false);
    const recommendationsTab = tabs.find((tab) => tab.view === "recommendations");
    if (recommendationsTab) {
      setActiveTabId(recommendationsTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [...prevTabs, { id: newId, view: "recommendations" }]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleCloseTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    if (tabs.length === 1) return;

    const closedTab = tabs.find((tab) => tab.id === tabId);
    if (!closedTab) return;

    const newTabs = tabs.filter((tab) => tab.id !== tabId);

    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const replacementMusicTab =
      tabs
        .slice(0, closedIndex)
        .reverse()
        .find((tab) => tab.id !== tabId && !isUtilityTab(tab)) ??
      tabs
        .slice(closedIndex + 1)
        .find((tab) => !isUtilityTab(tab));

    if (!isUtilityTab(closedTab) && tabManager.getActiveId() === tabId) {
      if (replacementMusicTab) {
        void tabManager.setActive(replacementMusicTab.id);
      }
    }

    if (activeTabId === tabId) {
      const playingTabId = tabManager.getActiveId();
      const playingTab = newTabs.find((tab) => tab.id === playingTabId);

      if (isUtilityTab(closedTab) && playingTab) {
        setActiveTabId(playingTab.id);
      } else {
        const nextTab = replacementMusicTab ?? newTabs[Math.max(0, closedIndex - 1)];
        if (!isUtilityTab(nextTab) && tabManager.getActiveId() !== nextTab.id) {
          void tabManager.setActive(nextTab.id);
        }
        setActiveTabId(nextTab.id);
      }
    }

    if (!isUtilityTab(closedTab)) {
      tabManager.removeTab(tabId);
    }
    setTabs(newTabs);
  };

  const handleSwitchTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    const tab = tabs.find((item) => item.id === tabId);
    if (tab && !isUtilityTab(tab)) {
      void tabManager.setActive(tabId);
    }
    setActiveTabId(tabId);
    if (onboardingStep === "switch-back" && tabId === onboardingFirstTabId) {
      markOnboardingComplete(true);
    }
  };

  const finishOnboarding = () => {
    markOnboardingComplete(false);
  };

  const handlePlaySearchTrack = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (
      (stepAtStart === "type-first" || stepAtStart === "play-first")
      && tabAtStart === onboardingFirstTabId
    ) {
      setOnboardingStep("new-tab");
      setIsSearchOpen(false);
    }
    if (
      (stepAtStart === "type-second" || stepAtStart === "play-second")
      && tabAtStart === onboardingSecondTabId
    ) {
      setOnboardingStep("switch-back");
      setIsSearchOpen(false);
    }
  };

  const handlePlaySearchResult = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (stepAtStart === "play-first" && tabAtStart === onboardingFirstTabId) {
      setOnboardingStep("new-tab");
    }
    if (stepAtStart === "play-second" && tabAtStart === onboardingSecondTabId) {
      setOnboardingStep("switch-back");
    }
  };

  const dismissSearch = () => {
    setIsSearchOpen(false);
    if (
      onboardingStep === "type-first"
      || onboardingStep === "play-first"
      || onboardingStep === "type-second"
      || onboardingStep === "play-second"
    ) {
      setOnboardingSearchQuery("");
      setOnboardingStep("open-search");
    }
  };

  const restartOnboarding = () => {
    const firstMusicTab = tabs.find((tab) => !isUtilityTab(tab));
    if (!firstMusicTab) return;
    clearLocalOnboardingComplete();
    setOnboardingComplete(false);
    setOnboardingFirstTabId(firstMusicTab.id);
    setOnboardingSecondTabId(null);
    setOnboardingSearchQuery("");
    setOnboardingStep("open-search");
    setShowOnboardingWelcome(false);
    void removeAppSetting(ONBOARDING_COMPLETE_SETTING_KEY);
    handleSwitchTab(firstMusicTab.id);
  };

  useEffect(() => {
    if (onboardingStep === "open-search" && isSearchOpen) {
      setOnboardingSearchQuery("");
      setOnboardingStep(
        onboardingSecondTabId && activeTabId === onboardingSecondTabId
          ? "type-second"
          : "type-first"
      );
    }
  }, [activeTabId, isSearchOpen, onboardingSecondTabId, onboardingStep]);

  useEffect(() => {
    if (!showOnboardingComplete) return;
    const timer = window.setTimeout(() => setShowOnboardingComplete(false), 3400);
    return () => window.clearTimeout(timer);
  }, [showOnboardingComplete]);

  useEffect(() => {
    if (!showOnboardingWelcome || loadingScreenState !== "hidden") return;
    const timer = window.setTimeout(() => setShowOnboardingWelcome(false), 2600);
    return () => window.clearTimeout(timer);
  }, [loadingScreenState, showOnboardingWelcome]);



  const handleToggleLyrics = () => {
    if (playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
      return;
    }

    const playbackTabId = tabManager.getPlaybackOwnerId();
    if (playbackTabId && playbackTabId !== activeTabId) {
      const playbackTab = tabs.find((tab) => tab.id === playbackTabId);
      if (playbackTab) {
        void tabManager.setActive(playbackTabId);
        setActiveTabId(playbackTabId);
      }
    }
    playerUIStore.setLyricsOpen(true);
  };

  const handleToggleQueue = () => {
    // Toggle asynchronously to avoid triggering synchronous store updates
    // during React commit phase which can cause "Maximum update depth".
    setTimeout(() => setIsQueuePanelOpen(!isQueuePanelOpen), 0);
  };

  useEffect(() => {
    if (isQueuePanelOpen) {
      // Mount the panel after commit to avoid nested update loops
      const id = window.setTimeout(() => setShowQueueMounted(true), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setShowQueueMounted(false), 200);
    return () => window.clearTimeout(id);
  }, [isQueuePanelOpen]);

  const handleReorderTab = (
    draggedTabId: string,
    targetTabId: string,
    insertAfter: boolean,
  ) => {
    setTabs((currentTabs) => {
      const draggedIndex = currentTabs.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return currentTabs;
      }

      const nextTabs = [...currentTabs];
      const [draggedTab] = nextTabs.splice(draggedIndex, 1);
      const adjustedTargetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);
      nextTabs.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, draggedTab);
      return nextTabs;
    });
    // Persist immediately so tab order survives app restart
    window.setTimeout(persistAppSession, 0);
  };


  useEffect(() => {
    const isTextEntry = (target: EventTarget | null) => {
      return target instanceof Element
        && target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    };

    const handleMouseNavigation = (event: MouseEvent) => {
      if (
        event.button !== MOUSE_BACK_BUTTON
        && event.button !== MOUSE_FORWARD_BUTTON
      ) {
        return;
      }
      if (isTextEntry(event.target)) return;

      if (event.button === MOUSE_BACK_BUTTON) {
        if (isSearchOpen && activeTab?.view !== "settings") {
          event.preventDefault();
          setIsSearchOpen(false);
          return;
        }
        if (canNavigateBack) {
          event.preventDefault();
          handleNavigateBack();
        }
        return;
      }

      if (canNavigateForward) {
        event.preventDefault();
        handleNavigateForward();
      }
    };

    const preventAuxNavigation = (event: MouseEvent) => {
      if (
        event.button === MOUSE_BACK_BUTTON
        || event.button === MOUSE_FORWARD_BUTTON
      ) {
        event.preventDefault();
      }
    };

    window.addEventListener("mousedown", handleMouseNavigation);
    window.addEventListener("auxclick", preventAuxNavigation);
    return () => {
      window.removeEventListener("mousedown", handleMouseNavigation);
      window.removeEventListener("auxclick", preventAuxNavigation);
    };
  }, [
    activeTab?.view,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    isSearchOpen,
  ]);

  useEffect(() => {
    const isTextEntry = (target: EventTarget | null) => {
      return target instanceof Element
        && target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    };

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.defaultPrevented) return;
      const textEntry = isTextEntry(event.target);

      if (!textEntry) {
        const tabShortcutIndex = TAB_SHORTCUT_ACTIONS.findIndex((action) =>
          eventMatchesShortcut(event, keyboardShortcuts[action])
        );
        const tab = tabs[tabShortcutIndex];
        if (tabShortcutIndex >= 0 && tab) {
          event.preventDefault();
          handleSwitchTab(tab.id);
        }
        if (tabShortcutIndex >= 0) return;
      }

      if (textEntry) return;

      if (
        eventMatchesShortcut(event, keyboardShortcuts.search)
        && activeTab?.view !== "settings"
      ) {
        event.preventDefault();
        if (isSearchOpen) dismissSearch();
        else setIsSearchOpen(true);
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.newTab)) {
        event.preventDefault();
        createTab();
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.closeTab)) {
        event.preventDefault();
        handleCloseTab(activeTabId);
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.navigateBack)) {
        if (isSearchOpen && activeTab?.view !== "settings") {
          event.preventDefault();
          setIsSearchOpen(false);
          return;
        }
        if (canNavigateBack) {
          event.preventDefault();
          handleNavigateBack();
        }
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.navigateForward)) {
        if (canNavigateForward) {
          event.preventDefault();
          handleNavigateForward();
        }
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.playPause)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.target instanceof HTMLElement) {
          event.target.blur();
        }
        void playerController.togglePlayPause();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.mute)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.toggleMute();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.previousTrack)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.skipToPrevious();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.nextTrack)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.skipToNext();
      }
    };

    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [
    activeTab?.view,
    activeTabId,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    isSearchOpen,
    keyboardShortcuts,
    nextTabId,
    onboardingStep,
    playerState.currentTrack,
    playerState.status,
    tabs,
  ]);


  const handlePlayerBarClick=()=>{
    setIsExpandedPlayerBar(!isExpandedPlayerBar)
  }



  // Keep the boot screen up while the very first session check is in
  // flight so signed-in users never see the gate flash.
  if (auth.status === "loading") {
    return <AppLoadingScreen isLeaving={false} />;
  }

  if (auth.status === "signed-out" || routePath === "/login") {
    const signedIn = auth.status === "signed-in";
    const leaveLogin = () => {
      navigateTo("/", true);
    };
    return (
      <LoginPage
        onSignedIn={() => {
          leaveLogin();
          handleAuthSuccess();
        }}
        // While gated out there is no way back to the app: the cancel
        // affordance only exists for a signed-in visitor who opened /login.
        onCancel={signedIn ? leaveLogin : undefined}
      />
    );
  }

  return (
    <ArtistNavigationProvider onNavigate={handleNavigateArtist}>
    <TrackContextMenuProvider libraryController={libraryController}>
    <PlaylistContextMenuProvider libraryController={libraryController}>
    <div className={styles.root}>
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={
          playerState.status === "playing"
            ? tabManager.getActivePlayerId()
            : null
        }
        sidebarWidth={sidebarWidth}
        isHomeActive={activeTab?.view === "home"}
        onNavigateHome={handleNavigateHome}
        onCreateTab={handleCreateTab}
        onCloseTab={handleCloseTab}
        onSwitchTab={handleSwitchTab}
        onReorderTab={handleReorderTab}
        onboardingFirstTabId={onboardingStep ? onboardingFirstTabId : undefined}
      />
      
      <div className={styles.content}>
       
        <Layout
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
          onNavigateAlbum={handleNavigateAlbum}
          onNavigatePlaylist={handleNavigatePlaylist}
          onOpenSettings={handleOpenSettings}
          onOpenHistory={handleOpenHistory}
          onOpenRecommendations={handleOpenRecommendations}
          onSignIn={handleSignIn}
          showSearchBar={activeTab?.view !== "settings" && !playerUIState.isLyricsOpen}
          onOpenSearch={() => setIsSearchOpen(true)}
          canGoBack={canNavigateBack}
          canGoForward={canNavigateForward}
          onNavigateBack={handleNavigateBack}
          onNavigateForward={handleNavigateForward}
          fullBleedContent={playerUIState.isLyricsOpen}
          showTransientScrollbar={
            !playerUIState.isLyricsOpen
            && (activeTab?.view === "playlist" || activeTab?.view === "album")
          }
          rightPanelWidth={queuePanelWidth}
          onRightPanelWidthChange={setQueuePanelWidth}
          rightPanel={showQueueMounted ? (
            <QueuePanel
              isOpen={isQueuePanelOpen}
              onClose={() => setIsQueuePanelOpen(false)}
            />
          ) : undefined}
        >
{/* <ExpandedPlayerBar 
        isOpen={isExpandedPlayerBar} 
        onClose={() => setIsExpandedPlayerBar(false)} 
      /> */}

          {playerUIState.isLyricsOpen && activeTab?.view !== "settings" ? (
            <LyricsView onClose={() => playerUIStore.setLyricsOpen(false)} />
          ) : (
          <div key={activeViewKey} className={styles.viewTransition}>
            {activeTab?.view === "home" && (
              <HomePage
                tabId={activeTabId}
                playerController={playerController}
                libraryController={libraryController}
                libraryState={libraryState}
                searchController={searchController}
                onSignIn={handleSignIn}
              />
            )}
            {activeTab?.view === "album" && (
              <AlbumView
                album={activeTab?.album}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "artist" && (
              <ArtistView
                artist={activeTab.artist}
                playerController={playerController}
                libraryController={libraryController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
              />
            )}
            {activeTab?.view === "playlist" && (
              <PlaylistView
                playlist={activeTab.playlist}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "search" && (
                <SearchResultsPage
                query={activeTab.searchQuery ?? ""}
                results={activeTab.mixedSearchResults ?? {
                  artists: [],
                  tracks: activeTab.searchResults ?? [],
                  albums: [],
                  playlists: [],
                }}
                isLoading={activeTab.searchLoading ?? false}
                  playerController={playerController}
                    onPlayTrack={handlePlaySearchResult}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
                />
            )}
            {activeTab?.view === "history" && <HistoryPage />}
            {activeTab?.view === "recommendations" && <RecommendationsPage />}
            {activeTab?.view === "settings" && (
              <SettingsPage
                libraryController={libraryController}
                libraryState={libraryState}
                onRestartOnboarding={restartOnboarding}
                onSignIn={handleSignIn}
              />
            )}
          </div>
          )}
        </Layout>
      </div>
      
      <PlayerBar
        onToggleLyrics={handleToggleLyrics}
        onToggleQueue={handleToggleQueue}
        isQueueOpen={isQueuePanelOpen}
        onConnectionRestored={handleConnectionRestored}
        handlePlayerBarClick={handlePlayerBarClick}
      />
      <SearchOverlay
        isOpen={isSearchOpen && activeTab?.view !== "settings"}
        activeTabId={activeTabId}
        searchController={searchController}
        albums={libraryState.library?.albums ?? []}
        playlists={libraryState.library?.playlists ?? []}
          onClose={() => setIsSearchOpen(false)}
          onDismiss={dismissSearch}
        onSubmit={handleSearch}
        onPlayTrack={(track) => void handlePlaySearchTrack(track)}
        onOpenAlbum={handleNavigateAlbum}
        onOpenArtist={(artist) => handleNavigateArtist(artist)}
        onOpenPlaylist={handleNavigatePlaylist}
        onQueryChange={setOnboardingSearchQuery}
      />
      {loadingScreenState !== "hidden" && (
        <AppLoadingScreen isLeaving={loadingScreenState === "leaving"} />
      )}
      {loadingScreenState === "hidden" && showOnboardingWelcome && (
        <OnboardingWelcome />
      )}
      {loadingScreenState === "hidden" && onboardingComplete === false && !showOnboardingWelcome && onboardingStep && (
        <Onboarding step={onboardingStep} onSkip={finishOnboarding} />
      )}
      {showOnboardingComplete && <OnboardingCompleteToast />}
      <ErrorToastViewport />
    </div>
    </PlaylistContextMenuProvider>
    </TrackContextMenuProvider>
    </ArtistNavigationProvider>
  );
}

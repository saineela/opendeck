import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App";
import "./ui/styles/global.css";
import { logInternalError, logInternalInfo } from "./internal/logging";
import { hydratePaperPcMode } from "./ui/settings/paperPcMode";
import { hydratePlayerControlSettings } from "./ui/settings/playerControls";
import { hydrateLastFmSettings } from "./ui/settings/lastfm";
import { hydrateKeyboardShortcuts } from "./ui/settings/keyboardShortcuts";
import { applyAppTheme, hydrateAppTheme } from "./ui/settings/themes";
import { applyPlatformAttributes } from "./ui/platform";
import { hydratePlaybackSettings } from "./player/playbackSettings";
import { hydrateAudioQualitySettings } from "./internal/audioQuality";
import { hydrateYouTubeAccountSettings } from "./ui/settings/youtubeAccount";
import { hydratePluginHost } from "./plugins/pluginHost";
import { registerDownloaderPlugin } from "./plugins/official/downloader/manifest";
import {
  hydrateDownloaderStore,
  setDownloaderStreamResolver,
} from "./plugins/official/downloader/downloaderStore";
import { resolveDownloadStream } from "./player/playerStore";
import { refreshAuthSession } from "./auth/authClient";

logInternalInfo("main.bootstrap start");
applyPlatformAttributes();
applyAppTheme();
registerDownloaderPlugin();
setDownloaderStreamResolver(resolveDownloadStream);

// Resolve the auth session first: it decides whether the durable server-side
// settings store is reachable, so hydration does not fire a burst of expected
// 401 requests while signed out. refreshAuthSession never rejects.
void refreshAuthSession()
  .then(() =>
    Promise.all([
      hydratePaperPcMode(),
      hydratePlayerControlSettings(),
      hydrateLastFmSettings(),
      hydrateKeyboardShortcuts(),
      hydratePlaybackSettings(),
      hydrateAudioQualitySettings(),
      hydrateYouTubeAccountSettings(),
      hydrateAppTheme(),
      hydratePluginHost().then(() => hydrateDownloaderStore()),
    ]),
  )
  .catch((error) => {
    logInternalError("settings hydration failed", error);
  });

window.addEventListener("error", (event) => {
  logInternalError("window.error", event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logInternalError("window.unhandledrejection", event.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

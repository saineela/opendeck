import type { PluginManifest } from "../../pluginHost";
import { registerOfficialPlugin } from "../../pluginHost";

export const DOWNLOADER_PLUGIN_ID = "downloader";

export const downloaderPluginManifest: PluginManifest = {
  schemaVersion: 1,
  id: DOWNLOADER_PLUGIN_ID,
  name: "Offline audio",
  version: "1.0.0",
  kind: "official",
  entry: "index.js",
  requiresRestart: false,
  // No `filesystem:write`: offline audio is stored in the browser's IndexedDB
  // and never written to the user's disk.
  permissions: [
    "tracks:read",
    "playlists:read",
    "downloads:write",
    "playback:source-resolver",
  ],
  settings: [
    {
      key: "quality",
      type: "select",
      label: "Quality",
      default: "normal",
      options: [
        { value: "high", label: "High" },
        { value: "normal", label: "Normal" },
        { value: "low", label: "Low" },
      ],
    },
    {
      key: "rediscoverDownloads",
      type: "action",
      label: "Verify offline audio",
      action: "rediscoverDownloads",
    },
  ],
};

export function registerDownloaderPlugin(): void {
  // Imported plugins will use the same host later. The official downloader is default-on.
  registerOfficialPlugin(downloaderPluginManifest, true);
}

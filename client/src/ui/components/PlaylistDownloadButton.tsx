import { useEffect, useState } from "react";
import { IconCheck, IconDownload, IconLoader2, IconPlayerPause } from "@tabler/icons-react";
import type { Playlist, Track } from "../../datasource/types";
import {
  getPlaylistDownloadSummary,
  togglePlaylistDownloads,
  useDownloaderState,
} from "../../plugins/official/downloader/downloaderStore";
import { usePluginEnabled } from "../../plugins/pluginHost";
import { DOWNLOADER_PLUGIN_ID } from "../../plugins/official/downloader/manifest";
import styles from "./PlaylistDownloadButton.module.css";

interface PlaylistDownloadButtonProps {
  playlist: Playlist;
  tracks: Track[];
  disabled?: boolean;
  onBeforeStart?: () => Promise<Track[]>;
}

export function PlaylistDownloadButton({
  playlist,
  tracks,
  disabled = false,
  onBeforeStart,
}: PlaylistDownloadButtonProps) {
  useDownloaderState();
  const [starting, setStarting] = useState(false);
  const pluginEnabled = usePluginEnabled(DOWNLOADER_PLUGIN_ID);
  const summary = getPlaylistDownloadSummary(playlist, tracks);
  const complete = summary.total > 0 && summary.downloaded >= summary.total && !summary.active;
  const busy = (summary.active || starting) && !summary.paused;

  useEffect(() => {
    if (summary.active || summary.paused || complete) setStarting(false);
  }, [complete, summary.active, summary.paused]);

  if (!pluginEnabled) return null;

  return (
    <button
      className={`${styles.button} ${busy ? styles.busy : ""} ${starting ? styles.starting : ""} ${complete ? styles.complete : ""}`}
      type="button"
      disabled={disabled || summary.total === 0 || complete}
      aria-label={summary.paused ? "Resume playlist download" : busy ? "Pause playlist download" : "Download playlist"}
      title={summary.paused ? "Resume download" : busy ? "Pause download" : complete ? "Downloaded" : "Download playlist"}
      onClick={async () => {
        if (busy || summary.paused) {
          togglePlaylistDownloads(tracks);
          return;
        }
        setStarting(true);
        try {
          const downloadTracks = onBeforeStart ? await onBeforeStart() : tracks;
          togglePlaylistDownloads(downloadTracks);
        } finally {
          setStarting(false);
        }
      }}
    >
      {complete ? (
        <IconCheck size={18} aria-hidden="true" />
      ) : summary.paused ? (
        <IconPlayerPause className={styles.pauseIcon} size={18} aria-hidden="true" />
      ) : busy ? (
        <IconLoader2 className={styles.spinner} size={18} aria-hidden="true" />
      ) : (
        <IconDownload size={18} aria-hidden="true" />
      )}
    </button>
  );
}

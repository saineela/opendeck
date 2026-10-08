import { useEffect, useRef, useState } from "react";
import { IconDownload, IconLoader2 } from "@tabler/icons-react";
import {
  pauseDownloads,
  useDownloaderState,
} from "../../plugins/official/downloader/downloaderStore";
import { usePluginEnabled } from "../../plugins/pluginHost";
import { DOWNLOADER_PLUGIN_ID } from "../../plugins/official/downloader/manifest";
import styles from "./DownloadsPopover.module.css";

export function DownloadsPopover() {
  const downloader = useDownloaderState();
  const pluginEnabled = usePluginEnabled(DOWNLOADER_PLUGIN_ID);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const activeTrack = downloader.downloadingId
    ? downloader.pending[downloader.downloadingId]
    : null;
  const queuedTracks = downloader.queued
    .map((id) => downloader.pending[id])
    .filter(Boolean)
    .slice(0, 3);
  const hasActivity = Boolean(activeTrack || queuedTracks.length > 0);

  if (!pluginEnabled || !hasActivity || downloader.paused) return null;

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={`${styles.button} ${hasActivity ? styles.buttonActive : ""}`}
        aria-label="Downloads"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {hasActivity ? (
          <IconLoader2 className={styles.spinner} size={16} aria-hidden="true" />
        ) : (
          <IconDownload size={16} aria-hidden="true" />
        )}
      </button>

      {open && (
        <section className={styles.panel} aria-label="Download queue">
          <header className={styles.panelHeader}>
            <strong>Downloads</strong>
            {hasActivity && (
              <button
                className={styles.panelAction}
                type="button"
                onClick={pauseDownloads}
              >
                Pause
              </button>
            )}
          </header>
          {activeTrack ? (
            <div className={styles.activeDownload}>
              <span>{activeTrack.title}</span>
              <div className={styles.progressTrack}>
                <span style={{ width: `${downloader.progress ?? 8}%` }} />
              </div>
            </div>
          ) : (
            <p className={styles.empty}>No active download.</p>
          )}
          {queuedTracks.length > 0 && (
            <div className={styles.queue}>
              {queuedTracks.map((track) => (
                <span key={track.id}>{track.title}</span>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

import { IconRefresh, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Lyrics } from "../../datasource/types";
import { logInternalWarn } from "../../internal/logging";
import { playerController, usePlayerState } from "../../player/playerStore";
import styles from "./LyricsView.module.css";
import { ArtistLinks } from "../components/ArtistLinks";

const AUTO_SCROLL_RESUME_MS = 4500;

interface LyricsViewProps {
  onClose: () => void;
}

export function LyricsView({ onClose }: LyricsViewProps) {
  const playerState = usePlayerState();
  const track = playerState.currentTrack;
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [manualScrollUntil, setManualScrollUntil] = useState(0);
  const autoScrollTimerRef = useRef<number | null>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setFailed(false);
    if (!track) return;

    setIsLoading(true);
    void playerController.getLyrics(track)
      .then((result) => {
        if (!cancelled) setLyrics(result);
      })
      .catch((error) => {
        logInternalWarn("LyricsView load failed", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [track?.id]);

  useEffect(() => {
    let frameId = 0;
    const update = () => {
      setCurrentTime(playerController.getCurrentTime());
      frameId = requestAnimationFrame(update);
    };
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const timedLines = lyrics?.lines ?? [];

  const activeIndex = useMemo(() => {
    if (!timedLines.length) return -1;
    if (timedLines.some((line) => line.startTimeSec === undefined)) return -1;
    let active = 0;
    for (let index = 0; index < timedLines.length; index += 1) {
      const start = timedLines[index].startTimeSec;
      if (start === undefined || currentTime < start) break;
      active = index;
    }
    return active;
  }, [currentTime, timedLines]);

  useEffect(() => {
    if (activeIndex < 0 || performance.now() < manualScrollUntil) return;
    lineRefs.current[activeIndex]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [activeIndex, manualScrollUntil]);

  const handleManualScroll = () => {
    if (activeIndex < 0) return;
    const resumeAt = performance.now() + AUTO_SCROLL_RESUME_MS;
    setManualScrollUntil(resumeAt);
    if (autoScrollTimerRef.current !== null) {
      window.clearTimeout(autoScrollTimerRef.current);
    }
    autoScrollTimerRef.current = window.setTimeout(() => {
      setManualScrollUntil(0);
      autoScrollTimerRef.current = null;
    }, AUTO_SCROLL_RESUME_MS);
  };

  const handleResync = () => {
    if (autoScrollTimerRef.current !== null) {
      window.clearTimeout(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
    setManualScrollUntil(0);
    lineRefs.current[activeIndex]?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  };

  useEffect(() => () => {
    if (autoScrollTimerRef.current !== null) {
      window.clearTimeout(autoScrollTimerRef.current);
    }
  }, []);

  const handleLineClick = (index: number) => {
    const target = timedLines[index]?.startTimeSec;
    if (target === undefined) return;
    setManualScrollUntil(0);
    void playerController.seekTo(target);
  };

  return (
    <section className={styles.view} aria-label="Lyrics">
      <div className={styles.backdrop} aria-hidden="true">
        {track?.artworkUrl && <img src={track.artworkUrl} alt="" />}
      </div>
      <header className={styles.header}>
        <span className={styles.eyebrow}>Lyrics</span>
        <h1>{track?.title ?? "Nothing playing"}</h1>
        {track && (
          <p>
            <ArtistLinks artists={track.artists} fallback={track.artist} />
          </p>
        )}
      </header>
      <button
        type="button"
        className={styles.closeButton}
        onClick={onClose}
        aria-label="Close lyrics"
        title="Close lyrics"
      >
        <IconX size={20} />
      </button>

      <div
        className={styles.scroller}
        onWheel={handleManualScroll}
        onPointerDown={handleManualScroll}
        onTouchMove={handleManualScroll}
      >
        <div className={styles.lyrics}>
          {isLoading && <p className={styles.message}>Loading lyrics...</p>}
          {!isLoading && (failed || !lyrics) && (
            <p className={styles.message}>Synchronized lyrics are not available for this song.</p>
          )}
          {!isLoading && timedLines.map((line, index) => (
            <button
              key={`${index}:${line.text}`}
              ref={(element) => {
                lineRefs.current[index] = element;
              }}
              type="button"
              className={`${styles.line} ${index === activeIndex ? styles.activeLine : ""}`}
              onClick={() => handleLineClick(index)}
              disabled={line.startTimeSec === undefined}
            >
              {line.text}
            </button>
          ))}
        </div>
      </div>
      {manualScrollUntil > 0 && activeIndex >= 0 && (
        <button
          type="button"
          className={styles.resyncButton}
          onClick={handleResync}
          aria-label="Resync lyrics to current playback position"
        >
          <IconRefresh size={16} aria-hidden="true" />
          <span>Resync</span>
        </button>
      )}
      <div className={styles.footer}>
        {lyrics?.sourceLabel && <span>Lyrics from {lyrics.sourceLabel}</span>}
      </div>
    </section>
  );
}

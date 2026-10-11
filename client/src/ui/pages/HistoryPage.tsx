import { useCallback, useEffect, useState } from "react";
import { IconHistory, IconTrash } from "@tabler/icons-react";
import {
  clearHistory,
  fetchHistoryPage,
  fetchHistoryStats,
  type HistoryPlay,
  type HistoryStats,
} from "../../internal/historyClient";
import { TrackArtwork } from "../components/TrackArtwork";
import styles from "./HistoryPage.module.css";

/**
 * Music History page: every play recorded by the server, including plays
 * made through the HTTP API with a bearer key (those are attributed to the
 * key that requested the stream). Backed by `GET /api/history` +
 * `GET /api/history/stats`; the list is fed by `/api/media/stream`, so both
 * app playback and API playback land here.
 */

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${totalSeconds} s`;
}

export function HistoryPage() {
  const [plays, setPlays] = useState<HistoryPlay[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const [page, statsResult] = await Promise.all([
        fetchHistoryPage(50, before),
        before ? Promise.resolve(null) : fetchHistoryStats(),
      ]);
      setPlays((current) => (before ? [...current, ...page.plays] : page.plays));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      if (statsResult) setStats(statsResult);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    try {
      await clearHistory();
      setConfirmClear(false);
      setPlays([]);
      setStats(null);
      await load();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Unable to clear history.");
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Library</span>
        <h1>Music history</h1>
        <p>
          Every play the server recorded for your account — from this app and from anything
          using the HTTP API with one of your keys.
        </p>
      </div>

      {stats && (
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <strong>{stats.totalPlays.toLocaleString()}</strong>
            <span>Total plays</span>
          </div>
          <div className={styles.statCard}>
            <strong>{stats.playsToday.toLocaleString()}</strong>
            <span>Today</span>
          </div>
          <div className={styles.statCard}>
            <strong>{stats.plays7d.toLocaleString()}</strong>
            <span>Last 7 days</span>
          </div>
          <div className={styles.statCard}>
            <strong>{formatDuration(stats.totalListeningSeconds)}</strong>
            <span>Listening time</span>
          </div>
          <div className={styles.statCard}>
            <strong>
              {stats.bySource.app.toLocaleString()} · {stats.bySource.api.toLocaleString()}
            </strong>
            <span>App · API plays</span>
          </div>
        </div>
      )}

      {stats && (stats.topTracks.length > 0 || stats.topArtists.length > 0) && (
        <div className={styles.topGrid}>
          {stats.topTracks.length > 0 && (
            <section className={styles.card} aria-labelledby="top-tracks-title">
              <h2 id="top-tracks-title">Top tracks</h2>
              <ol className={styles.topList}>
                {stats.topTracks.map((track) => (
                  <li key={track.videoId}>
                    <span className={styles.topTitle}>{track.title}</span>
                    <span className={styles.topMeta}>
                      {track.artist || "Unknown artist"} · {track.plays}{" "}
                      {track.plays === 1 ? "play" : "plays"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {stats.topArtists.length > 0 && (
            <section className={styles.card} aria-labelledby="top-artists-title">
              <h2 id="top-artists-title">Top artists</h2>
              <ol className={styles.topList}>
                {stats.topArtists.map((artist) => (
                  <li key={artist.artist}>
                    <span className={styles.topTitle}>{artist.artist}</span>
                    <span className={styles.topMeta}>
                      {artist.plays} {artist.plays === 1 ? "play" : "plays"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      <section className={styles.card} aria-labelledby="plays-title">
        <div className={styles.playsHeader}>
          <h2 id="plays-title">Recent plays</h2>
          <button
            className={`${styles.clearButton} ${confirmClear ? styles.clearButtonArmed : ""}`}
            type="button"
            disabled={plays.length === 0}
            onClick={() => void handleClear()}
          >
            <IconTrash size={15} aria-hidden="true" />
            {confirmClear ? "Click again to confirm" : "Clear history"}
          </button>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {plays.length === 0 && !loading ? (
          <p className={styles.empty}>
            <IconHistory size={18} aria-hidden="true" />
            {stats ? "Nothing here yet — plays appear as soon as music streams." : "No plays recorded yet."}
          </p>
        ) : (
          <ul className={styles.playList}>
            {plays.map((play) => (
              <li key={play.id} className={styles.playRow}>
                <TrackArtwork
                  className={styles.playArtwork}
                  artworkUrl={play.artworkUrl ?? undefined}
                  iconSize={20}
                />
                <span className={styles.playText}>
                  <strong>{play.title}</strong>
                  <span>{play.artist || "Unknown artist"}</span>
                </span>
                <span
                  className={`${styles.sourceBadge} ${play.source === "api" ? styles.sourceBadgeApi : ""}`}
                >
                  {play.source === "api"
                    ? `API · ${play.apiKeyLabel ?? "key"}`
                    : "App"}
                </span>
                <span className={styles.playTime}>{formatRelativeTime(play.playedAt)}</span>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <button
            className={styles.moreButton}
            type="button"
            disabled={loading}
            onClick={() => void load(nextCursor ?? undefined)}
          >
            {loading ? "Loading…" : "Load older plays"}
          </button>
        )}
      </section>
    </main>
  );
}

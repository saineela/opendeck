import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBell,
  IconBellOff,
  IconGift,
  IconLoader2,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import {
  deleteRecommendation,
  disablePushNotifications,
  enablePushNotifications,
  fetchInbox,
  fetchSent,
  markRecommendationRead,
  pushNotificationsEnabled,
  pushSupported,
  type Recommendation,
} from "../../internal/recommendationsClient";
import { playerController } from "../../player/playerStore";
import { TrackArtwork } from "../components/TrackArtwork";
import styles from "./RecommendationsPage.module.css";

/**
 * Recommendations page: songs other OpenDeck accounts sent you, plus what
 * you sent. Reading a recommendation marks it read; play streams it through
 * the normal player. The bell toggle subscribes this device to Web Push so
 * new recommendations notify you even with the tab closed (the service
 * worker at /sw.js shows the notification).
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

type Tab = "inbox" | "sent";

export function RecommendationsPage() {
  const [tab, setTab] = useState<Tab>("inbox");
  const [inbox, setInbox] = useState<Recommendation[]>([]);
  const [sent, setSent] = useState<Recommendation[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushAvailable, setPushAvailable] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inboxResult, sentResult, pushOn] = await Promise.all([
        fetchInbox(),
        fetchSent(),
        pushNotificationsEnabled().catch(() => false),
      ]);
      if (!mountedRef.current) return;
      setInbox(inboxResult.recommendations);
      setUnreadCount(inboxResult.unreadCount);
      setSent(sentResult);
      setPushEnabled(pushOn);
      setError(null);
    } catch (loadError) {
      if (!mountedRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load recommendations.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setPushAvailable(pushSupported());
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const handlePlay = async (recommendation: Recommendation) => {
    if (playingId) return;
    setPlayingId(recommendation.id);
    try {
      await playerController.playTrackById(
        recommendation.videoId,
        [
          {
            id: recommendation.videoId,
            source: "youtube",
            title: recommendation.title,
            artist: recommendation.artist,
            album: recommendation.album ?? undefined,
            durationSec: recommendation.durationSeconds ?? undefined,
            artworkUrl: recommendation.artworkUrl ?? undefined,
          },
        ],
        true,
      );
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : "Unable to play this song.");
    } finally {
      setPlayingId(null);
    }
  };

  const handleRowClick = (recommendation: Recommendation) => {
    if (recommendation.readAt !== null) return;
    setInbox((current) =>
      current.map((item) =>
        item.id === recommendation.id ? { ...item, readAt: Date.now() } : item,
      ),
    );
    setUnreadCount((current) => Math.max(0, current - 1));
    void markRecommendationRead(recommendation.id).catch(() => {
      // The row already looks read; refresh on next load reconciles.
    });
  };

  const handleDelete = async (recommendation: Recommendation, list: "inbox" | "sent") => {
    const remove = () => {
      if (list === "inbox") {
        setInbox((current) => current.filter((item) => item.id !== recommendation.id));
        if (recommendation.readAt === null) {
          setUnreadCount((current) => Math.max(0, current - 1));
        }
      } else {
        setSent((current) => current.filter((item) => item.id !== recommendation.id));
      }
    };
    remove();
    try {
      await deleteRecommendation(recommendation.id);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to remove this recommendation.");
      void load();
    }
  };

  const handleTogglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushEnabled) {
        await disablePushNotifications();
        setPushEnabled(false);
      } else {
        const subscription = await enablePushNotifications();
        setPushEnabled(subscription !== null);
      }
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : "Unable to update push notifications.");
    } finally {
      setPushBusy(false);
    }
  };

  const items = tab === "inbox" ? inbox : sent;

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Social</span>
        <h1>Recommendations</h1>
        <p>
          Songs other OpenDeck users sent you. Play one instantly, or right-click any track
          anywhere in the app and choose “Recommend to…” to send it to someone.
        </p>
      </div>

      <div className={styles.controls}>
        <div className={styles.tabs} role="tablist" aria-label="Recommendation lists">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "inbox"}
            className={`${styles.tab} ${tab === "inbox" ? styles.tabActive : ""}`}
            onClick={() => setTab("inbox")}
          >
            Received
            {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sent"}
            className={`${styles.tab} ${tab === "sent" ? styles.tabActive : ""}`}
            onClick={() => setTab("sent")}
          >
            Sent
          </button>
        </div>
        {pushAvailable && (
          <button
            type="button"
            className={`${styles.pushButton} ${pushEnabled ? styles.pushButtonActive : ""}`}
            disabled={pushBusy}
            onClick={() => void handleTogglePush()}
            title={
              pushEnabled
                ? "Disable push notifications for new recommendations"
                : "Get notified when someone recommends a song"
            }
          >
            {pushBusy ? (
              <IconLoader2 size={15} aria-hidden="true" />
            ) : pushEnabled ? (
              <IconBell size={15} aria-hidden="true" />
            ) : (
              <IconBellOff size={15} aria-hidden="true" />
            )}
            {pushEnabled ? "Notifications on" : "Enable notifications"}
          </button>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <section className={styles.card}>
        {loading ? (
          <p className={styles.empty}>
            <IconLoader2 size={18} aria-hidden="true" />
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className={styles.empty}>
            <IconGift size={18} aria-hidden="true" />
            {tab === "inbox"
              ? "No recommendations yet — when someone sends you a song it lands here."
              : "You have not recommended any songs yet."}
          </p>
        ) : (
          <ul className={styles.list}>
            {items.map((recommendation) => (
              <li
                key={recommendation.id}
                className={`${styles.row} ${
                  tab === "inbox" && recommendation.readAt === null ? styles.rowUnread : ""
                }`}
                onClick={() => tab === "inbox" && handleRowClick(recommendation)}
              >
                <TrackArtwork
                  className={styles.artwork}
                  artworkUrl={recommendation.artworkUrl ?? undefined}
                  iconSize={20}
                />
                <span className={styles.text}>
                  <strong>{recommendation.title}</strong>
                  <span>
                    {recommendation.artist || "Unknown artist"}
                    {tab === "inbox" ? ` · from ${recommendation.senderName}` : " · to a friend"}
                  </span>
                  {recommendation.note && <em className={styles.note}>“{recommendation.note}”</em>}
                </span>
                {tab === "inbox" && recommendation.readAt === null && (
                  <span className={styles.unreadDot} aria-label="Unread" />
                )}
                <span className={styles.time}>{formatRelativeTime(recommendation.createdAt)}</span>
                <button
                  type="button"
                  className={styles.playButton}
                  disabled={playingId === recommendation.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handlePlay(recommendation);
                  }}
                  aria-label={`Play ${recommendation.title}`}
                  title="Play"
                >
                  {playingId === recommendation.id ? (
                    <IconLoader2 size={16} aria-hidden="true" />
                  ) : (
                    <IconPlayerPlay size={16} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className={styles.deleteButton}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDelete(recommendation, tab);
                  }}
                  aria-label={`Remove recommendation for ${recommendation.title}`}
                  title={tab === "inbox" ? "Dismiss" : "Delete"}
                >
                  <IconTrash size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

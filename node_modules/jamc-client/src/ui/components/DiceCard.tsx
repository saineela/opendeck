import { useEffect, useState } from "react";
import { IconArrowsShuffle, IconMusic } from "@tabler/icons-react";
import type { Track } from "../../datasource/types";
import styles from "./DiceCard.module.css";

interface DiceCardProps {
  tracks: Track[];
  isSpinning?: boolean;
  onClick?: () => void;
}

export function DiceCard({ tracks, isSpinning = false, onClick }: DiceCardProps) {
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    if (!isSpinning || tracks.length === 0) return;
    const intervalId = window.setInterval(() => {
      setPreviewIndex((index) => (index + 1) % tracks.length);
    }, 90);
    return () => window.clearInterval(intervalId);
  }, [isSpinning, tracks.length]);

  const preview = tracks[previewIndex % Math.max(1, tracks.length)];

  return (
    <button
      className={styles.card}
      onClick={onClick}
      type="button"
      disabled={tracks.length === 0 || isSpinning}
      aria-label="Surprise me with a recommendation"
    >
      <div className={styles.cover}>
        {preview?.artworkUrl ? (
          <img
            key={`${preview.id}-${previewIndex}`}
            className={`${styles.artwork} ${isSpinning ? styles.spinning : ""}`}
            src={preview.artworkUrl}
            alt=""
          />
        ) : (
          <IconMusic size={48} className={styles.fallbackIcon} />
        )}
        <span className={styles.shuffleBadge}>
          <IconArrowsShuffle size={20} />
        </span>
      </div>
      <span className={styles.title}>Surprise me</span>
      <span className={styles.subtitle}>Pick something for me</span>
    </button>
  );
}

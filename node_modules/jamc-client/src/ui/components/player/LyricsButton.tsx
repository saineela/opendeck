import { IconMicrophone2 } from "@tabler/icons-react";
import { usePlayerState } from "../../../player/playerStore";
import { usePlayerUIState } from "../../stores/playerUIStore";
import styles from "./LyricsButton.module.css";

interface LyricsButtonProps {
  onToggle: () => void;
}

export function LyricsButton({ onToggle }: LyricsButtonProps) {
  const playerState = usePlayerState();
  const uiState = usePlayerUIState();

  return (
    <button
      type="button"
      className={`${styles.button} ${uiState.isLyricsOpen ? styles.active : ""}`}
      onClick={onToggle}
      disabled={!playerState.currentTrack}
      aria-label={uiState.isLyricsOpen ? "Close lyrics" : "Open lyrics"}
      aria-pressed={uiState.isLyricsOpen}
    >
      <IconMicrophone2 size={19} />
    </button>
  );
}

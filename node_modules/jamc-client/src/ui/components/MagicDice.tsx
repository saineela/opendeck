import { IconDice } from "@tabler/icons-react";
import styles from "./MagicDice.module.css";

interface MagicDiceProps {
  onClick?: () => void;
}

export function MagicDice({ onClick }: MagicDiceProps) {
  return (
    <div className={styles.container}>
      <button
        className={styles.diceButton}
        type="button"
        aria-label="Magic Dice"
        onClick={onClick}
      >
        <IconDice size={40} className={styles.diceIcon} />
      </button>
    </div>
  );
}

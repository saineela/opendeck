import { IconLayoutDashboard } from "@tabler/icons-react";
import { useMemo, useRef } from "react";
import styles from "./TitleBar.module.css";
import { MusicTabs } from "./MusicTabs";
import type { Tab } from "../types/tab";
import { DownloadsPopover } from "./DownloadsPopover";

/**
 * Tab strip header. The desktop variant also hosted the custom window frame
 * (drag region, minimize/maximize/close); browsers provide their own window
 * chrome, so only the app-level content remains: Home button, music tabs,
 * downloads popover.
 */

interface TitleBarProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  sidebarWidth: number;
  isHomeActive: boolean;
  onNavigateHome: () => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onboardingFirstTabId?: string;
}

export function TitleBar({
  tabs,
  activeTabId,
  playingTabId,
  sidebarWidth,
  isHomeActive,
  onNavigateHome,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onboardingFirstTabId,
}: TitleBarProps) {
  const homePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressHomeClickRef = useRef(false);
  const hideHomeText = sidebarWidth <= 120;

  const homeButtonClasses = useMemo(() => [
    styles.homeButton,
    isHomeActive ? styles.homeButtonActive : "",
    hideHomeText ? styles.homeButtonIconOnly : "",
  ].filter(Boolean).join(" "), [isHomeActive, hideHomeText]);

  return (
    <div className={styles.root}>
      <button
        type="button"
        className={homeButtonClasses}
        style={{ width: `${sidebarWidth}px` }}
        onClick={() => {
          if (suppressHomeClickRef.current) {
            suppressHomeClickRef.current = false;
            return;
          }
          onNavigateHome();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressHomeClickRef.current = false;
          homePointerRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pointer = homePointerRef.current;
          if (!pointer || pointer.pointerId !== event.pointerId) return;

          const distance = Math.hypot(
            event.clientX - pointer.startX,
            event.clientY - pointer.startY,
          );
          if (distance < 8) return;

          // A drag gesture on the Home button should not trigger navigation.
          homePointerRef.current = null;
          suppressHomeClickRef.current = true;
        }}
        onPointerUp={(event) => {
          if (homePointerRef.current?.pointerId === event.pointerId) {
            homePointerRef.current = null;
          }
        }}
        onPointerCancel={() => {
          homePointerRef.current = null;
        }}
        aria-label="Home"
        aria-current={isHomeActive ? "page" : undefined}
      >
        <IconLayoutDashboard size={18} aria-hidden="true" />
        {!hideHomeText && <span>Home</span>}
      </button>

      <MusicTabs
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={playingTabId}
        onCreateTab={onCreateTab}
        onCloseTab={onCloseTab}
        onSwitchTab={onSwitchTab}
        onReorderTab={onReorderTab}
        onboardingFirstTabId={onboardingFirstTabId}
      />

      <div className={styles.dragArea} aria-hidden="true" />

      <DownloadsPopover />
    </div>
  );
}

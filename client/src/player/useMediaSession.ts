import { useEffect } from "react";
import type { PlayerState } from "./PlayerController";
import type { PlayerControllerActions } from "./playerStore";

/**
 * Browser Media Session integration. The desktop app had an extra native
 * Windows media-key bridge (Rust); on the web the platform's own
 * `navigator.mediaSession` provides OS media controls, which is exactly the
 * browser branch that already existed here.
 */

function getBrowserPlaybackState(status: PlayerState["status"]): MediaSessionPlaybackState {
  if (status === "playing" || status === "loading") return "playing";
  if (status === "paused") return "paused";
  return "none";
}

export function useMediaSession(
  state: PlayerState,
  controller: PlayerControllerActions,
): void {
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void controller.play(),
      pause: () => void controller.pause(),
      stop: () => void controller.pause(),
      nexttrack: () => void controller.skipToNext(),
      previoustrack: () => void controller.skipToPrevious(),
      seekto: (details) => {
        if (details.seekTime !== undefined) void controller.seekTo(details.seekTime);
      },
      seekbackward: (details) => {
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.max(0, controller.getCurrentTime() - offset));
      },
      seekforward: (details) => {
        const duration = controller.getDuration();
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.min(duration, controller.getCurrentTime() + offset));
      },
    };

    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(
          action as MediaSessionAction,
          handler as MediaSessionActionHandler,
        );
      } catch {
        // Some actions are unsupported in some browsers.
      }
    }

    return () => {
      for (const action of Object.keys(handlers) as MediaSessionAction[]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported actions during cleanup.
        }
      }
    };
  }, [controller]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const track = state.currentTrack;
    try {
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist,
            artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : [],
          })
        : null;
      navigator.mediaSession.playbackState = getBrowserPlaybackState(state.status);
    } catch {
      // Media Session support varies by browser.
    }
  }, [state.currentTrack, state.status]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !state.currentTrack) return;

    const updatePosition = () => {
      const duration = controller.getDuration() || state.currentTrack?.durationSec || 0;
      const position = Math.min(duration, Math.max(0, controller.getCurrentTime()));
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position,
          });
        } catch {
          // Position state support varies by browser.
        }
      }
    };

    updatePosition();
    const intervalId = window.setInterval(updatePosition, 1000);
    return () => window.clearInterval(intervalId);
  }, [controller, state.currentTrack, state.status]);
}

import { useSyncExternalStore } from "react";

/**
 * Potato PC mode is permanently on: animations, blur effects, and the
 * animated star background are always disabled, on every machine, no
 * matter what is stored anywhere. The toggle was removed from Settings,
 * so this module no longer reads or writes a preference — it only exposes
 * the constant and applies the `data-paper-pc` attribute.
 */

function subscribe(): () => void {
  return () => {};
}

function readPaperPcMode(): boolean {
  return true;
}

export function applyPaperPcMode(): void {
  document.documentElement.toggleAttribute("data-paper-pc", true);
}

export function usePaperPcMode(): boolean {
  return useSyncExternalStore(subscribe, readPaperPcMode, readPaperPcMode);
}

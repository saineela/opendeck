import {
  eventMatchesShortcut,
  type KeyboardShortcutMap,
} from "../settings/keyboardShortcuts";

const TEXT_ENTRY_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY_SELECTOR) !== null;
}

export function shouldStartPageSearch(
  event: KeyboardEvent,
  keyboardShortcuts: KeyboardShortcutMap,
): boolean {
  if (event.repeat || event.defaultPrevented || event.isComposing) return false;
  if (isTextEntry(event.target)) return false;
  if (event.key.length !== 1 || event.key.trim() === "") return false;
  return !Object.values(keyboardShortcuts).some((shortcut) =>
    eventMatchesShortcut(event, shortcut)
  );
}

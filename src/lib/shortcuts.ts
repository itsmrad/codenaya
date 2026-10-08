/**
 * Keyboard shortcuts that work in the app today, shown in the shortcut sheet.
 *
 * Keys are platform-neutral tokens: `mod` is ⌘ on Mac and Ctrl elsewhere.
 * Keep this list in sync with the handlers it describes.
 */

export type ShortcutKey = "mod" | "shift" | "enter" | "esc" | "tab" | string;

export interface Shortcut {
  label: string;
  /** Alternative bindings for the same action, e.g. `?` or `mod+/`. */
  keys: ShortcutKey[][];
  scope: ShortcutScope;
}

export const SHORTCUT_SCOPES = ["General", "Dashboard", "Chat", "Editor"] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

export const SHORTCUTS: Shortcut[] = [
  { label: "Keyboard shortcuts", keys: [["?"], ["mod", "/"]], scope: "General" },

  { label: "Find a project", keys: [["mod", "k"]], scope: "Dashboard" },
  { label: "New project", keys: [["mod", "j"]], scope: "Dashboard" },
  { label: "Import from GitHub", keys: [["mod", "i"]], scope: "Dashboard" },

  { label: "Send message", keys: [["enter"]], scope: "Chat" },
  { label: "New line", keys: [["shift", "enter"]], scope: "Chat" },
  { label: "Stop the agent", keys: [["esc"]], scope: "Chat" },

  { label: "Quick edit the selection", keys: [["mod", "k"]], scope: "Editor" },
  { label: "Accept AI suggestion", keys: [["tab"]], scope: "Editor" },
  { label: "Close quick edit", keys: [["esc"]], scope: "Editor" },
  { label: "Toggle comment", keys: [["mod", "/"]], scope: "Editor" },
  { label: "Find in file", keys: [["mod", "f"]], scope: "Editor" },
];

const MAC_LABELS: Record<string, string> = { mod: "⌘", shift: "⇧" };
const OTHER_LABELS: Record<string, string> = { mod: "Ctrl", shift: "Shift" };
const COMMON_LABELS: Record<string, string> = { enter: "Enter", esc: "Esc", tab: "Tab" };

/** Display label for one key token, e.g. `mod` → `⌘` on Mac, `Ctrl` elsewhere. */
export const formatShortcutKey = (key: ShortcutKey, isMac: boolean): string =>
  (isMac ? MAC_LABELS : OTHER_LABELS)[key] ?? COMMON_LABELS[key] ?? key.toUpperCase();

/** True when focus is somewhere typing `?` should insert text. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
};

/** `?` outside a text field, or Cmd/Ctrl+/ anywhere it isn't already handled. */
export const isShortcutSheetKey = (event: KeyboardEvent): boolean => {
  if (event.defaultPrevented || event.altKey) return false;
  if (event.key === "/" && (event.metaKey || event.ctrlKey)) return true;
  return (
    event.key === "?" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !isTypingTarget(event.target)
  );
};

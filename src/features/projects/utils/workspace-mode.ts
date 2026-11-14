import type { IdeView } from "./ide-session";

/**
 * The account's workspace layout (#524). "ide" is today's full layout and the
 * default; "chat" shows only the chat and the preview.
 */
export type WorkspaceMode = "ide" | "chat";

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "ide";

/**
 * The view tabs a mode shows. Desktops keep the chat as a side panel, so it is
 * never one of their tabs.
 */
export const visibleViews = (mode: WorkspaceMode, isCompact: boolean): IdeView[] => {
  const views: IdeView[] = mode === "chat" ? ["chat", "preview"] : ["chat", "editor", "preview"];
  return isCompact ? views : views.filter((view) => view !== "chat");
};

/**
 * The view to show for a picked or saved one. The chat on a desktop falls back
 * to the first tab; a hidden Code view falls back to the preview.
 */
export const activeViewFor = (view: IdeView, mode: WorkspaceMode, isCompact: boolean): IdeView => {
  const views = visibleViews(mode, isCompact);
  if (views.includes(view)) return view;
  return view === "chat" ? views[0] : "preview";
};

/** The saved mode; while loading or after a failed read, the device's copy. */
export const resolveWorkspaceMode = (
  saved: WorkspaceMode | Error | undefined,
  cached: WorkspaceMode,
): WorkspaceMode => (saved === undefined || saved instanceof Error ? cached : saved);

// Device copy of the account setting, so a project opens in the right layout
// before the Convex query resolves.
const WORKSPACE_MODE_KEY = "codenaya:workspace-mode";

export const loadCachedWorkspaceMode = (): WorkspaceMode => {
  try {
    return localStorage.getItem(WORKSPACE_MODE_KEY) === "chat" ? "chat" : DEFAULT_WORKSPACE_MODE;
  } catch {
    return DEFAULT_WORKSPACE_MODE;
  }
};

export const cacheWorkspaceMode = (mode: WorkspaceMode) => {
  try {
    localStorage.setItem(WORKSPACE_MODE_KEY, mode);
  } catch {
    // Without storage the layout waits for the query instead.
  }
};

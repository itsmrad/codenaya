import type { IdeView } from "./ide-session";

/**
 * The account's workspace layout (#524). "ide" is today's full layout and the
 * default; "chat" shows only the chat and the preview; "board" (#525) opens on
 * the swarm board, with the chat and the preview beside it.
 */
export type WorkspaceMode = "ide" | "chat" | "board";

const MODE_VIEWS: Record<WorkspaceMode, IdeView[]> = {
  ide: ["chat", "editor", "preview"],
  chat: ["chat", "preview"],
  board: ["chat", "board", "preview"],
};

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "ide";

/**
 * The view tabs a mode shows. Desktops keep the chat as a side panel, so it is
 * never one of their tabs.
 */
export const visibleViews = (mode: WorkspaceMode, isCompact: boolean): IdeView[] => {
  const views = MODE_VIEWS[mode];
  return isCompact ? views : views.filter((view) => view !== "chat");
};

/**
 * The view to show for a picked or saved one. The chat on a desktop falls back
 * to the first tab; a hidden view falls back to the board in board mode, else
 * to the preview.
 */
export const activeViewFor = (view: IdeView, mode: WorkspaceMode, isCompact: boolean): IdeView => {
  const views = visibleViews(mode, isCompact);
  if (views.includes(view)) return view;
  if (mode === "board") return "board";
  return view === "chat" ? views[0] : "preview";
};

/**
 * The saved mode; while loading or after a failed read, the device's copy.
 * The board needs swarm: once the switch reads off (or fails), "board" is "ide".
 */
export const resolveWorkspaceMode = (
  saved: WorkspaceMode | Error | undefined,
  cached: WorkspaceMode,
  swarmEnabled: boolean | Error | undefined,
): WorkspaceMode => {
  const mode = saved === undefined || saved instanceof Error ? cached : saved;
  return mode === "board" && (swarmEnabled === false || swarmEnabled instanceof Error) ? "ide" : mode;
};

// Device copy of the account setting, so a project opens in the right layout
// before the Convex query resolves.
const WORKSPACE_MODE_KEY = "codenaya:workspace-mode";

export const loadCachedWorkspaceMode = (): WorkspaceMode => {
  try {
    const mode = localStorage.getItem(WORKSPACE_MODE_KEY);
    return mode === "chat" || mode === "board" ? mode : DEFAULT_WORKSPACE_MODE;
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

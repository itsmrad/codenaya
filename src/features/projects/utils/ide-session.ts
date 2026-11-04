/**
 * Where the user left a project's IDE (#315): the view and the open tabs,
 * kept per project in this browser so a reload or a return visit reopens
 * there. Storage can be unavailable, so every access is best-effort, like
 * the pending prompt in this folder.
 */
export type IdeView = "chat" | "editor" | "preview";

export interface IdeSession {
  view: IdeView;
  openTabs: string[];
  activeTabId: string | null;
}

const IDE_VIEWS: readonly string[] = ["chat", "editor", "preview"];

export const ideSessionKey = (projectId: string) => `codenaya:ide:${projectId}`;

/** The saved session, or null when there is none or it isn't one we wrote. */
export const loadIdeSession = (projectId: string): IdeSession | null => {
  try {
    const raw = localStorage.getItem(ideSessionKey(projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<IdeSession>;
    if (!IDE_VIEWS.includes(value.view as string) || !Array.isArray(value.openTabs)) return null;
    return {
      view: value.view as IdeView,
      openTabs: value.openTabs.filter((id): id is string => typeof id === "string"),
      activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    };
  } catch {
    return null;
  }
};

export const saveIdeSession = (projectId: string, session: IdeSession) => {
  try {
    localStorage.setItem(ideSessionKey(projectId), JSON.stringify(session));
  } catch {
    // Without storage the IDE simply opens on its defaults next time.
  }
};

/**
 * The saved tabs whose files still exist. A deleted active tab falls back to
 * the last remaining one.
 */
export const restorableTabs = (session: IdeSession, existingIds: ReadonlySet<string>) => {
  const openTabs = session.openTabs.filter((id) => existingIds.has(id));
  const activeTabId =
    session.activeTabId && openTabs.includes(session.activeTabId)
      ? session.activeTabId
      : (openTabs.at(-1) ?? null);
  return { openTabs, activeTabId };
};

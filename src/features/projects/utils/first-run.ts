/**
 * Browser-side flags for the dashboard's first-run checklist. Storage can be
 * unavailable (private mode, blocked site data), so every access is
 * best-effort: without it the checklist simply shows again next visit.
 */
export const PREVIEW_OPENED_KEY = "codenaya:previewOpened";
const DISMISSED_KEY_PREFIX = "codenaya:firstRunDismissed:";

const read = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const write = (key: string) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Best-effort.
  }
};

/** Set once a project's preview has rendered in this browser. */
export const markPreviewOpened = () => write(PREVIEW_OPENED_KEY);
export const hasOpenedPreview = () => read(PREVIEW_OPENED_KEY);

/** Dismissal is per user, so a shared browser keeps each user's choice. */
export const dismissFirstRun = (userId: string) => write(DISMISSED_KEY_PREFIX + userId);
export const isFirstRunDismissed = (userId: string) => read(DISMISSED_KEY_PREFIX + userId);

export interface FirstRunData {
  projects: { exportStatus?: string }[];
  published: { status: string }[];
  aiKeyCount: number;
  skillCount: number;
  githubConnected: boolean;
  previewOpened: boolean;
}

/** Which checklist steps are done, derived from the user's real data. */
export const getFirstRunProgress = (data: FirstRunData) => ({
  createProject: data.projects.length > 0,
  openPreview: data.previewOpened,
  connectGithub: data.githubConnected,
  addKeyOrSkill: data.aiKeyCount + data.skillCount > 0,
  ship:
    data.published.some((entry) => entry.status === "published") ||
    data.projects.some((project) => project.exportStatus === "completed"),
});

export type FirstRunStep = keyof ReturnType<typeof getFirstRunProgress>;

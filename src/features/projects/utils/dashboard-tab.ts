/**
 * The dashboard tab a returning user last picked. Storage can be unavailable
 * (private mode, blocked site data), so access is best-effort: without it the
 * dashboard opens on Projects.
 */
export const DASHBOARD_TABS = ["projects", "templates", "community"] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

const KEY = "codenaya:dashboardTab";

const isDashboardTab = (value: unknown): value is DashboardTab =>
  DASHBOARD_TABS.includes(value as DashboardTab);

export const readDashboardTab = (): DashboardTab => {
  try {
    const stored = localStorage.getItem(KEY);
    return isDashboardTab(stored) ? stored : "projects";
  } catch {
    return "projects";
  }
};

export const writeDashboardTab = (tab: DashboardTab) => {
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // Best-effort.
  }
};

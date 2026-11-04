import { useCallback, useEffect, useState } from "react";

import { readDashboardTab, writeDashboardTab, type DashboardTab } from "../utils/dashboard-tab";

/** The dashboard's selected tab, remembered across visits in this browser. */
export const useDashboardTab = () => {
  const [tab, setTabState] = useState<DashboardTab>("projects");

  // Storage can only be read after mount, or the server render would mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabState(readDashboardTab());
  }, []);

  const setTab = useCallback((next: DashboardTab) => {
    setTabState(next);
    writeDashboardTab(next);
  }, []);

  return [tab, setTab] as const;
};

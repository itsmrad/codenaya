type BuildStep = { tool?: string; status: string };

/**
 * A build-checking run may have lost HMR (#774). Its final step update can arrive
 * with activeRun=null, so include a check last observed running. Chat-only runs stay put.
 */
export const needsRunEndReload = (firstBuildEnded: boolean, steps: readonly BuildStep[]) =>
  firstBuildEnded || steps.some((step) => step.tool === "checkBuild");

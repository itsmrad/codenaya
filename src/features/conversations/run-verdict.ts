import {
  type AgentStep,
  type StuckRun,
  BUILD_CHECK_UNFINISHED,
  BUILD_VERIFIED,
  FILE_WRITE_TOOLS,
  fixedBuildErrors,
  runWrittenPaths,
} from "./agent-steps";

export const RUN_VERDICT_LABELS = {
  verified: "Verified",
  unverified: "Unverified",
  "no-changes": "No changes",
  errors: "Unresolved errors",
} as const;

interface Run {
  status?: "processing" | "completed" | "cancelled";
  mode?: "plan" | "swarm";
  steps?: AgentStep[];
  stuck?: StuckRun;
}

/** Completed build replies only; missing status is a completed legacy reply. */
export const runVerdict = ({ status = "completed", mode, steps = [], stuck }: Run): keyof typeof RUN_VERDICT_LABELS | null => {
  if (status !== "completed" || mode) return null;
  const tools = steps.filter((step) => step.kind === "tool");
  const pending = new Set<string>();
  let lastWrite = -1;
  let lastCheck = -1;
  for (const [index, step] of tools.entries()) {
    if (step.tool === "checkBuild") {
      lastCheck = index;
      continue;
    }
    const writes = FILE_WRITE_TOOLS.has(step.tool ?? "");
    if (writes) lastWrite = index;
    const keys = writes && step.targets?.length
      ? step.targets
      : [`${step.tool}:${JSON.stringify(step.targets ?? [])}`];
    if (step.status === "error") keys.forEach((key) => pending.add(key));
    if (step.status === "done") {
      keys.forEach((key) => pending.delete(key));
    }
  }
  const failedChecks = tools.filter((step) =>
    step.tool === "checkBuild" && step.status === "error" &&
    !step.error?.startsWith(BUILD_CHECK_UNFINISHED),
  ).length;
  if (pending.size || failedChecks > fixedBuildErrors(tools)) return "errors";
  if (!runWrittenPaths(tools).length) return "no-changes";
  const check = tools[lastCheck];
  return !stuck && lastCheck > lastWrite && check?.status === "done" && check.text === BUILD_VERIFIED
    ? "verified"
    : "unverified";
};

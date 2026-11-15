import { z } from "zod";

import { MAX_SWARM_AGENTS, MAX_SWARM_TASKS } from "../../../convex/swarm";
import { normalizePath } from "./agent-steps";

export { MAX_SWARM_AGENTS, MAX_SWARM_TASKS };
export const WORKER_MAX_STEPS = 20;
export const MAX_WORKER_USD = 0.50;
/** A brief is a worker's whole prompt: ~3k tokens fits a detailed spec, and 4 tasks stay under ~12k tokens. */
export const MAX_BRIEF_CHARS = 12_000;
/** How long a worker may queue and run before it counts as failed (step.invoke's timeout). */
export const WORKER_TIMEOUT_MS = 12 * 60_000;
export const CHILD_WORKER_TIMEOUT_MS = 10 * 60_000;
export const SUBORCH_TIMEOUT_MS = 25 * 60_000;
/** A sub-orchestrator splits its owned paths among up to 3 workers of its own (depth 2). */
export const MAX_SUBORCHESTRATORS = 2;
export const MAX_SUBORCH_CHILDREN = 3;
export const SUBORCH_MAX_STEPS = 30;
export const MAX_SUBORCH_USD = 1.50;
/** The orchestrator is depth 0; its tasks are 1, a sub-orchestrator's children 2. */
export const MAX_SWARM_DEPTH = 2;
export const SWARM_SHARED_PATHS = [
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "index.html", "components.json", "src/main.tsx", "src/App.tsx", "src/index.css", "src/lib/utils.ts",
] as const;

export const swarmPlanSchema = z.object({
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().trim().min(1),
    brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS),
    ownedPaths: z.array(z.string()).min(1),
    role: z.enum(["worker", "sub-orchestrator"]).optional(),
  })).max(MAX_SWARM_TASKS),
  solo: z.string().trim().min(1).max(200).optional()
    .describe("Only for a genuinely tiny request, with tasks []: why you build it yourself. The swarm board shows it."),
}).refine(({ tasks, solo }) => tasks.length >= 2 || (tasks.length === 0 && Boolean(solo)), {
  message: "Delegate 2-4 tasks, or pass tasks [] with solo set to why this is too tiny to split",
  path: ["tasks"],
});
export type SwarmPlan = z.infer<typeof swarmPlanSchema>;

/** The file tools' own normalisation, so ownership judges the path a tool acts on; only paths under src/. */
const canonical = (raw: string) => {
  const path = normalizePath(raw);
  return path?.startsWith("src/") ? path : undefined;
};
/** `path` is `folder` itself or inside it: every path is a file or a folder. */
const within = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);
// A shared file, or a folder holding one: a recursive delete would take it too.
const shared = (path: string) => SWARM_SHARED_PATHS.some((file) => within(path, file));

/** Whether a write or (recursive) delete of `raw` stays inside owned paths and spares shared files. */
export const ownsPath = (ownedPaths: readonly string[], raw: string): boolean => {
  const path = canonical(raw);
  return path !== undefined && !shared(path) && ownedPaths.some((owned) => {
    const root = canonical(owned);
    return root !== undefined && !shared(root) && within(root, path);
  });
};

/**
 * Tool-facing validation errors let the orchestrator repair its plan.
 * `withinPaths`: a sub-orchestrator's plan, whose workers split its own owned paths.
 * `maxDepth`: how deep this run's swarm may go; below MAX_SWARM_DEPTH it has no sub-orchestrators.
 */
export const validatePlan = (
  input: unknown,
  { withinPaths, maxDepth = MAX_SWARM_DEPTH }: { withinPaths?: readonly string[]; maxDepth?: number } = {},
): SwarmPlan | string => {
  const parsed = swarmPlanSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue.code === "too_big" && issue.path[2] === "brief") {
      const task = (input as { tasks: { id: unknown; brief: string }[] }).tasks[issue.path[1] as number];
      return `Error: The brief for task ${String(task.id)} is ${task.brief.trim().length} characters; the limit is ${MAX_BRIEF_CHARS}. Shorten it and call delegateTasks again.`;
    }
    return `Error: ${issue.message}`;
  }
  const { tasks } = parsed.data;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return "Error: Task ids must be unique.";
  const subs = tasks.filter((task) => task.role === "sub-orchestrator").length;
  if (withinPaths && subs) return "Error: Your tasks can only be workers.";
  if (subs && maxDepth < MAX_SWARM_DEPTH) return 'Error: Sub-orchestrators are off for this run; give every task the role "worker".';
  if (withinPaths && tasks.length > MAX_SUBORCH_CHILDREN) return `Error: Delegate at most ${MAX_SUBORCH_CHILDREN} tasks.`;
  if (subs > MAX_SUBORCHESTRATORS) return `Error: At most ${MAX_SUBORCHESTRATORS} tasks can be sub-orchestrators.`;
  const owned: { id: string; path: string }[] = [];
  for (const task of tasks) {
    for (const raw of task.ownedPaths) {
      const path = canonical(raw);
      if (!path) return `Error: Invalid owned path "${raw}"; use a project-relative path under src/.`;
      if (shared(path)) return `Error: "${raw}" is or holds a shared file reserved for the orchestrator.`;
      if (withinPaths && !ownsPath(withinPaths, path)) return `Error: "${raw}" is outside your owned paths.`;
      const other = owned.find((o) => o.id !== task.id && (within(o.path, path) || within(path, o.path)));
      if (other) return `Error: Owned paths overlap between ${other.id} and ${task.id}.`;
      owned.push({ id: task.id, path });
    }
  }
  return { tasks: tasks.map((task) => ({ ...task, ownedPaths: task.ownedPaths.map((raw) => canonical(raw)!) })) };
};

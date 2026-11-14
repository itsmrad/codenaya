import { z } from "zod";

import { MAX_SWARM_AGENTS, MAX_SWARM_TASKS } from "../../../convex/swarm";

export { MAX_SWARM_AGENTS, MAX_SWARM_TASKS };
export const WORKER_MAX_STEPS = 20;
export const MAX_WORKER_USD = 0.50;
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
    brief: z.string().trim().min(1).max(2000),
    ownedPaths: z.array(z.string()).min(1),
    role: z.enum(["worker", "sub-orchestrator"]).optional(),
  })).min(2, "build it yourself").max(MAX_SWARM_TASKS),
});
export type SwarmPlan = z.infer<typeof swarmPlanSchema>;

// Ownership is canonical and deliberately stricter than the file tools' path normalization.
const validPath = (path: string) => path.startsWith("src/") && path === path.trim() &&
  !path.includes("\\") && !/[\x00-\x1f]/.test(path) &&
  path.replace(/\/$/, "").split("/").every((part) => part && part !== "." && part !== "..");
const covers = (owned: string, path: string) => owned === path ||
  (owned.endsWith("/") && (path.startsWith(owned) || path === owned.slice(0, -1)));
const shared = (path: string) => SWARM_SHARED_PATHS.some((p) => covers(path, p) || covers(p, path)) ||
  /^(?:vite|ts|tailwind)[^/]*config[^/]*$/.test(path) || /^tsconfig[^/]*\.json$/.test(path);

/** Whether a canonical file/folder path is wholly owned, including recursive deletes. */
export const ownsPath = (ownedPaths: readonly string[], path: string): boolean =>
  validPath(path) && !shared(path) && ownedPaths.some((owned) => validPath(owned) && covers(owned, path));

/**
 * Tool-facing validation errors let the orchestrator repair its plan.
 * `withinPaths`: a sub-orchestrator's plan, whose workers split its own owned paths.
 */
export const validatePlan = (input: unknown, { withinPaths }: { withinPaths?: readonly string[] } = {}): SwarmPlan | string => {
  const parsed = swarmPlanSchema.safeParse(input);
  if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;
  const { tasks } = parsed.data;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return "Error: Task ids must be unique.";
  const subs = tasks.filter((task) => task.role === "sub-orchestrator").length;
  if (withinPaths && subs) return "Error: Your tasks can only be workers.";
  if (withinPaths && tasks.length > MAX_SUBORCH_CHILDREN) return `Error: Delegate at most ${MAX_SUBORCH_CHILDREN} tasks.`;
  if (subs > MAX_SUBORCHESTRATORS) return `Error: At most ${MAX_SUBORCHESTRATORS} tasks can be sub-orchestrators.`;
  for (const [i, task] of tasks.entries()) {
    for (const path of task.ownedPaths) {
      if (!validPath(path)) return `Error: Invalid owned path "${path}"; use canonical paths under src/.`;
      if (shared(path)) return `Error: "${path}" includes a shared path reserved for the orchestrator.`;
      if (withinPaths && !ownsPath(withinPaths, path)) return `Error: "${path}" is outside your owned paths.`;
      for (const other of tasks.slice(0, i)) {
        if (other.ownedPaths.some((p) => covers(p, path) || covers(path, p) ||
          path.startsWith(`${p}/`) || p.startsWith(`${path}/`))) {
          return `Error: Owned paths overlap between ${other.id} and ${task.id}.`;
        }
      }
    }
  }
  return parsed.data;
};

import { z } from "zod";

import { MAX_SWARM_TASKS } from "../../../convex/swarm";

export { MAX_SWARM_TASKS };
export const WORKER_MAX_STEPS = 20;
export const MAX_WORKER_USD = 0.50;
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

/** Tool-facing validation errors let the orchestrator repair its plan. */
export const validatePlan = (input: unknown): SwarmPlan | string => {
  const parsed = swarmPlanSchema.safeParse(input);
  if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;
  const { tasks } = parsed.data;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return "Error: Task ids must be unique.";
  for (const [i, task] of tasks.entries()) {
    for (const path of task.ownedPaths) {
      if (!validPath(path)) return `Error: Invalid owned path "${path}"; use canonical paths under src/.`;
      if (shared(path)) return `Error: "${path}" includes a shared path reserved for the orchestrator.`;
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

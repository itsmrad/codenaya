import { z } from "zod";

import { MAX_SWARM_TASKS } from "../../../convex/swarm";
import { normalizePath } from "./agent-steps";

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

/** Tool-facing validation errors let the orchestrator repair its plan. */
export const validatePlan = (input: unknown): SwarmPlan | string => {
  const parsed = swarmPlanSchema.safeParse(input);
  if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;
  const { tasks } = parsed.data;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return "Error: Task ids must be unique.";
  const owned: { id: string; path: string }[] = [];
  for (const task of tasks) {
    for (const raw of task.ownedPaths) {
      const path = canonical(raw);
      if (!path) return `Error: Invalid owned path "${raw}"; use a project-relative path under src/.`;
      if (shared(path)) return `Error: "${raw}" is or holds a shared file reserved for the orchestrator.`;
      const other = owned.find((o) => o.id !== task.id && (within(o.path, path) || within(path, o.path)));
      if (other) return `Error: Owned paths overlap between ${other.id} and ${task.id}.`;
      owned.push({ id: task.id, path });
    }
  }
  return { tasks: tasks.map((task) => ({ ...task, ownedPaths: task.ownedPaths.map((raw) => canonical(raw)!) })) };
};

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

/** Before delegation the orchestrator writes only the foundation: these folders, shared files and root files. */
const FOUNDATION_FOLDERS = ["src/lib", "src/types", "src/styles", "src/theme", "src/data"];
/** A file this short is a page stub (`export default () => null;`) that keeps App.tsx's imports resolving. */
export const FOUNDATION_PLACEHOLDER_MAX_CHARS = 240;

/** Whether the orchestrator may write `raw` before delegateTasks: configs, shared files, lib/types/styles/theme/data. */
export const isFoundationPath = (raw: string): boolean => {
  const path = normalizePath(raw);
  if (!path) return false;
  if (path !== "src" && !path.startsWith("src/")) return true;
  return (SWARM_SHARED_PATHS as readonly string[]).includes(path) || /^src\/[^/]+\.d\.ts$/.test(path)
    || path === "src/types.ts" || FOUNDATION_FOLDERS.some((folder) => path.startsWith(`${folder}/`));
};

// Pages, screens and features a request can name; two distinct ones make it worth splitting.
const FEATURE_RE = /\b(home|landing|menu|about|contact|reservation|booking|gallery|pricing|service|blog|faq|team|career|testimonial|dashboard|login|sign-?up|register|profile|setting|cart|checkout|product|catalog|order|customer|deal|lead|pipeline|calendar|appointment|schedule|report|analytics|inbox|admin|portfolio|shop|event|location|dentist|confirmation|payment|invoice)s?\b/g;
const COUNTED_RE = /\bmulti-?page\b|\b(?:\d+|two|three|four|five|six|several|multiple)[- ](?:page|screen|section)s?\b/;
const EDIT_RE = /^(?:please\s+)?(?:change|fix|rename|update|tweak|adjust|move|remove|delete|replace|make the|set|increase|decrease|align|center|add an?)\b/;
// An edit names pages in passing ("a contact form on the home page"): it splits only when it adds pages.
const MULTI_PAGE_RE = /\b(?:pages|screens)\b|\b(?:page|screen)\s*(?:,|and\b|&|\+)/;
// An edit of a shared element touches every page through one shared file: it never splits.
const SHARED_EDIT_RE = /^(?:please\s+)?(?:update|change|fix|tweak|rename)\b.*\b(?:header|footer|nav|navbar|logo|colou?rs?|theme|fonts?)\b/;
const EDIT_MAX_CHARS = 120;
const LONG_REQUEST_CHARS = 300;

/**
 * Whether a swarm request is split among workers, decided before the run so it is
 * deterministic: two or more named pages or features (in an edit, only with several
 * pages: "a menu page and a contact page"), or a counted "N pages", is delegated; a short
 * edit stays solo; a long request is delegated.
 */
export const classifySwarmPrompt = (prompt: string): { delegate: boolean; reason: string } => {
  const text = prompt.trim().toLowerCase();
  const edit = EDIT_RE.test(text) && text.length <= EDIT_MAX_CHARS;
  if (edit && SHARED_EDIT_RE.test(text)) return { delegate: false, reason: "a small edit" };
  const features = [...new Set([...text.matchAll(FEATURE_RE)].map((match) => match[1]))];
  if (features.length >= 2 && (!edit || MULTI_PAGE_RE.test(text))) {
    return { delegate: true, reason: `it names ${features.length} pages or features (${features.join(", ")})` };
  }
  if (COUNTED_RE.test(text)) return { delegate: true, reason: "it asks for several pages" };
  if (edit) return { delegate: false, reason: "a small edit" };
  if (text.length >= LONG_REQUEST_CHARS) return { delegate: true, reason: "a long build request" };
  return { delegate: false, reason: "a short request with no separate pages or features" };
};

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
      const path = normalizePath(raw);
      if (!path || path === "src") return `Error: Invalid owned path "${raw}"; use a project-relative path under src/.`;
      if (!path.startsWith("src/")) return `Error: Owned path "${raw}" is outside src/. Tasks own only paths under src/; write public/ and other root files yourself before delegating, or drop it from ownedPaths, then call delegateTasks again.`;
      if (shared(path)) return `Error: "${raw}" is or holds a shared file reserved for the orchestrator.`;
      if (withinPaths && !ownsPath(withinPaths, path)) return `Error: "${raw}" is outside your owned paths.`;
      const other = owned.find((o) => o.id !== task.id && (within(o.path, path) || within(path, o.path)));
      if (other) return `Error: Owned paths overlap between ${other.id} and ${task.id}.`;
      owned.push({ id: task.id, path });
    }
  }
  return { tasks: tasks.map((task) => ({ ...task, ownedPaths: task.ownedPaths.map((raw) => canonical(raw)!) })) };
};

import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { PRE_UI_STARTER, VITE_REACT_STARTER } from "../vite-starter";
import { getFileByAgentId } from "./get-file";
import {
  folderEnsurer,
  folderPaths,
  getProjectFiles,
  indexProjectFiles,
  lockedPathError,
  splitPath,
  type ProjectIndex,
} from "./paths";

const STARTER = new Map(VITE_REACT_STARTER.map((file) => [file.path, file.content]));
const DEP_SECTIONS = ["dependencies", "devDependencies"] as const;
type Manifest = Partial<Record<(typeof DEP_SECTIONS)[number], Record<string, string>>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseManifest = (content: string): Manifest | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isObject(parsed) && DEP_SECTIONS.every((key) => parsed[key] === undefined || isObject(parsed[key]))) {
      return parsed as Manifest;
    }
  } catch {
    // Reported by the caller.
  }
  return undefined;
};

const STARTER_MANIFEST = parseManifest(STARTER.get("package.json")!)!;

/**
 * Brings files kept from a pre-#294 starter up to what the description
 * promises: adds the starter's missing pinned packages to package.json
 * (never touching the user's own) and replaces files still exactly as the old
 * starter wrote them. Returns a line per change and per promise not kept.
 */
const upgradeKeptFiles = async (
  internalKey: string,
  projectId: Id<"projects">,
  index: ProjectIndex,
  kept: string[],
  messageId?: Id<"messages">,
) => {
  const notes: string[] = [];
  // package.json last: the preview reinstalls when it changes.
  const paths = kept.filter((path) => path === "package.json" || path in PRE_UI_STARTER);
  paths.sort((a, b) => Number(a === "package.json") - Number(b === "package.json"));
  for (const path of paths) {
    const file = index.byPath.get(path)?.file;
    const current = file && (await getFileByAgentId(internalKey, projectId, file._id));
    if (!current) continue;
    const content = current.content ?? "";

    let next: string;
    let change: string;
    if (path === "package.json") {
      const pkg = parseManifest(content);
      if (!pkg) {
        const needed = DEP_SECTIONS.flatMap((section) => Object.keys(STARTER_MANIFEST[section] ?? {}));
        notes.push(`package.json could not be parsed, so it was left as is. Fix it and keep these packages in it: ${needed.join(", ")}.`);
        continue;
      }
      const added: string[] = [];
      for (const section of DEP_SECTIONS) {
        for (const [name, range] of Object.entries(STARTER_MANIFEST[section] ?? {})) {
          if (DEP_SECTIONS.some((other) => name in (pkg[other] ?? {}))) continue;
          pkg[section] = { ...pkg[section], [name]: range };
          added.push(`${name}@${range}`);
        }
      }
      if (added.length === 0) continue;
      next = `${JSON.stringify(pkg, null, 2)}\n`;
      change = `added ${added.join(", ")}`;
    } else if (content === PRE_UI_STARTER[path]) {
      next = STARTER.get(path)!;
      change = "replaced the unchanged old starter copy with the current one";
    } else {
      if (path === "src/main.tsx" && !content.includes("<Toaster")) {
        notes.push(
          'Kept your src/main.tsx, but src/main.tsx does not mount <Toaster /> from "@/components/ui/sonner": render it once there or toast() shows nothing.',
        );
      }
      continue;
    }

    await convex.mutation(api.system.updateFile, { messageId, internalKey, projectId, fileId: current._id, content: next });
    notes.push(`Updated ${path}: ${change}.`);
  }
  return notes;
};

interface ScaffoldViteAppToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  messageId?: Id<"messages">;
}

export const createScaffoldViteAppTool = ({
  projectId,
  internalKey,
  messageId,
}: ScaffoldViteAppToolOptions) => {
  return createTool({
    name: "scaffoldViteApp",
    description:
      "Write the known-good Vite + React + TypeScript + Tailwind + shadcn starter into the project root: " +
      VITE_REACT_STARTER.map((file) => file.path).join(", ") +
      ". Common shadcn/ui components and their Radix dependencies are already included: import from @/components/ui/<name>, do not rewrite them. Add other components only when needed. Sonner Toaster is mounted in src/main.tsx; import toast from sonner. It boots in the preview as-is. Call it first when starting a new Vite + React app, then extend it. Files that already exist are kept, except that it adds missing starter packages to package.json and updates files an older starter wrote that were never changed; the result names anything still missing. " +
      "The router and an error boundary are already mounted in src/main.tsx; add routes in src/App.tsx. Don't add another <BrowserRouter>.",
    parameters: z.object({}),
    handler: async (_params, { step: toolStep }) => {
      try {
        return await toolStep?.run("scaffold-vite-app", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index), messageId);

          const byDir = new Map<string, { name: string; content: string }[]>();
          const locked: string[] = [];
          // A starter file a lock keeps out of the project: the starter is incomplete (#548).
          let blocked = false;
          for (const file of VITE_REACT_STARTER) {
            // Skipped before any write, so no folder is made inside a locked one (#307).
            if (lockedPathError(index, file.path)) {
              locked.push(file.path);
              blocked ||= !index.byPath.get(file.path)?.file;
              continue;
            }
            const { dir, name } = splitPath(file.path);
            byDir.set(dir, [...(byDir.get(dir) ?? []), { name, content: file.content }]);
          }

          const created: string[] = [];
          const kept: string[] = [];
          // Root last: the preview starts booting once package.json exists, so
          // it must land with (not before) the files the starter references (#254).
          const batches = [...byDir].sort(([a], [b]) => Number(a === "") - Number(b === ""));
          let heldBack: string[] = [];
          for (const [dir, files] of batches) {
            if (dir === "" && blocked) {
              heldBack = files.map((file) => file.name);
              break;
            }
            let parentId;
            try {
              parentId = await ensureFolder(dir);
            } catch (error) {
              // A folder locked after the snapshot also refuses the folders inside it (#548).
              if (getAppError(error)?.code !== "FORBIDDEN") throw error;
              locked.push(...files.map((file) => `${dir}/${file.name}`));
              blocked = true;
              continue;
            }
            const results = await convex.mutation(api.system.createFiles, {
              messageId,
              internalKey,
              projectId,
              parentId,
              files,
            });
            for (const result of results) {
              const path = dir ? `${dir}/${result.name}` : result.name;
              if (!result.error) created.push(path);
              else if (result.fileId) kept.push(path);
              else {
                // Refused with no file: its folder was locked after the snapshot (#548).
                locked.push(path);
                blocked = true;
              }
            }
          }

          // An "Error" result, so the run doesn't count it as a finished starter (#548).
          return [
            blocked
              ? `Error: Incomplete scaffold. Locks kept starter files out${heldBack.length > 0 ? `, so ${heldBack.join(", ")} were not written either and the preview won't start` : ""}. Created: ${created.join(", ") || "nothing"}.`
              : `Scaffolded the Vite + React starter. Created: ${created.join(", ") || "nothing"}.`,
            kept.length > 0 ? `Kept existing: ${kept.join(", ")}.` : "",
            // Not when blocked: an incomplete starter must not get a package.json bump and reinstall.
            ...(blocked ? [] : await upgradeKeptFiles(internalKey, projectId, index, kept, messageId)),
            locked.length > 0 ? `Not written, locked by the user: ${locked.join(", ")}. Don't modify them.` : "",
            blocked
              ? "Tell the user the Vite starter needs these paths unlocked."
              : "Extend package.json with editFile, keeping every package it lists: the starter's config and entry files import them.",
          ]
            .filter(Boolean)
            .join("\n");
        });
      } catch (error) {
        return `Error scaffolding Vite app: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { VITE_REACT_STARTER } from "../vite-starter";
import { folderEnsurer, folderPaths, getProjectFiles, indexProjectFiles, splitPath } from "./paths";

interface ScaffoldViteAppToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

export const createScaffoldViteAppTool = ({
  projectId,
  internalKey,
}: ScaffoldViteAppToolOptions) => {
  return createTool({
    name: "scaffoldViteApp",
    description:
      "Write the known-good Vite + React + TypeScript + Tailwind + shadcn starter into the project root: " +
      VITE_REACT_STARTER.map((file) => file.path).join(", ") +
      ". It boots in the preview as-is. Call it first when starting a new Vite + React app, then extend it. Files that already exist are kept. " +
      "The router and an error boundary are already mounted in src/main.tsx; add routes in src/App.tsx. Don't add another <BrowserRouter>.",
    parameters: z.object({}),
    handler: async (_params, { step: toolStep }) => {
      try {
        return await toolStep?.run("scaffold-vite-app", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index));

          const byDir = new Map<string, { name: string; content: string }[]>();
          for (const file of VITE_REACT_STARTER) {
            const { dir, name } = splitPath(file.path);
            byDir.set(dir, [...(byDir.get(dir) ?? []), { name, content: file.content }]);
          }

          const created: string[] = [];
          const kept: string[] = [];
          // Root last: the preview starts booting once package.json exists, so
          // it must land with (not before) the files the starter references (#254).
          const batches = [...byDir].sort(([a], [b]) => Number(a === "") - Number(b === ""));
          for (const [dir, files] of batches) {
            const results = await convex.mutation(api.system.createFiles, {
              internalKey,
              projectId,
              parentId: await ensureFolder(dir),
              files,
            });
            for (const result of results) {
              const path = dir ? `${dir}/${result.name}` : result.name;
              (result.error ? kept : created).push(path);
            }
          }

          return [
            `Scaffolded the Vite + React starter. Created: ${created.join(", ") || "nothing"}.`,
            kept.length > 0 ? `Kept existing: ${kept.join(", ")}.` : "",
            "Extend package.json with updateFile, keeping every package it lists: the starter's config and entry files import them.",
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

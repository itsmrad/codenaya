import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { buildPathIndex } from "@/features/conversations/agent-steps";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { VITE_REACT_STARTER } from "../vite-starter";

interface ScaffoldViteAppToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
};

export const createScaffoldViteAppTool = ({
  projectId,
  internalKey,
}: ScaffoldViteAppToolOptions) => {
  return createTool({
    name: "scaffoldViteApp",
    description:
      "Write the known-good Vite + React + TypeScript + Tailwind + shadcn starter into the project root: " +
      VITE_REACT_STARTER.map((file) => file.path).join(", ") +
      ". It boots in the preview as-is. Call it first when starting a new Vite + React app, then extend it. Files that already exist are kept.",
    parameters: z.object({}),
    handler: async (_params, { step: toolStep }) => {
      try {
        return await toolStep?.run("scaffold-vite-app", async () => {
          const existing = await convex.query(api.system.getProjectFiles, {
            internalKey,
            projectId,
          });
          const pathOf = buildPathIndex(existing);
          const folders = new Map<string, Id<"files">>(
            existing
              .filter((file) => file.type === "folder")
              .map((folder) => [pathOf(folder._id) ?? folder.name, folder._id]),
          );

          const ensureFolder = async (path: string): Promise<Id<"files"> | undefined> => {
            if (!path) return undefined;
            const known = folders.get(path);
            if (known) return known;
            const { dir, name } = splitPath(path);
            const folderId = await convex.mutation(api.system.createFolder, {
              internalKey,
              projectId,
              name,
              parentId: await ensureFolder(dir),
            });
            folders.set(path, folderId);
            return folderId;
          };

          const byDir = new Map<string, { name: string; content: string }[]>();
          for (const file of VITE_REACT_STARTER) {
            const { dir, name } = splitPath(file.path);
            byDir.set(dir, [...(byDir.get(dir) ?? []), { name, content: file.content }]);
          }

          const created: string[] = [];
          const kept: string[] = [];
          for (const [dir, files] of byDir) {
            const results = await convex.mutation(api.system.createFiles, {
              internalKey,
              projectId,
              parentId: await ensureFolder(dir),
              files,
            });
            for (const result of results) {
              const path = dir ? `${dir}/${result.name}` : result.name;
              (result.error ? kept : created).push(`${path} (${result.fileId})`);
            }
          }

          const folderIds = [...folders]
            .map(([path, id]) => `${path} (${id})`)
            .join(", ");
          return [
            `Scaffolded the Vite + React starter. Created: ${created.join(", ") || "nothing"}.`,
            kept.length > 0 ? `Kept existing: ${kept.join(", ")}.` : "",
            `Folders: ${folderIds}.`,
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

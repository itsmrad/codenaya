import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import {
  ancestorsOf,
  createFolderEnsurer,
  loadProjectTree,
  parseAgentPath,
  splitPath,
} from "./paths";
import { checkPackageVersions } from "./package-versions";
import { syntaxErrorNote } from "./syntax-error";

interface WriteFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z.object({
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .min(1, "Provide at least one file to write"),
});

/** Root-level files last: the preview boots once package.json exists (#254). */
const rootLast = <T extends { path: string }>(files: T[]) =>
  [...files].sort((a, b) => Number(!a.path.includes("/")) - Number(!b.path.includes("/")));

export const createWriteFilesTool = ({ projectId, internalKey }: WriteFilesToolOptions) => {
  return createTool({
    name: "writeFiles",
    description:
      "Create or overwrite files by path, like src/components/ui/button.tsx. Missing parent folders are created, so never create folders first. Batch many files in one call.",
    parameters: z.object({
      files: z
        .array(
          z.object({
            path: z.string().describe("Project-relative path with / separators, like src/App.tsx"),
            content: z.string().describe("The full file content"),
          }),
        )
        .describe("Files to create or overwrite"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      try {
        return await toolStep?.run("write-files", async () => {
          const { byPath } = await loadProjectTree(internalKey, projectId);
          const ensureFolder = createFolderEnsurer(internalKey, projectId, byPath);
          const lines: string[] = [];
          const notes: string[] = [];
          const written: { name: string; content: string }[] = [];

          for (const file of rootLast(parsed.data.files)) {
            const target = parseAgentPath(file.path);
            if ("error" in target) {
              lines.push(`Error: ${target.error}`);
              continue;
            }
            const { path } = target;
            const existing = byPath.get(path);
            if (existing?.type === "folder") {
              lines.push(`Error: "${path}" is a folder; write to a file path inside it`);
              continue;
            }
            const blocking = ancestorsOf(path).find((dir) => byPath.get(dir)?.type === "file");
            if (blocking) {
              lines.push(`Error: "${blocking}" is a file, so "${path}" cannot be inside it`);
              continue;
            }

            // Same known-good versions as createFiles and updateFile (#331).
            const { dir, name } = splitPath(path);
            const { content, note } = checkPackageVersions(name, file.content);
            if (note) notes.push(note);

            if (existing) {
              await convex.mutation(api.system.updateFile, {
                internalKey,
                projectId,
                fileId: existing._id,
                content,
              });
              lines.push(`Updated ${path}`);
            } else {
              const [result] = await convex.mutation(api.system.createFiles, {
                internalKey,
                projectId,
                parentId: await ensureFolder(dir),
                files: [{ name, content }],
              });
              if (result?.error) {
                lines.push(`Error: ${path}: ${result.error}`);
                continue;
              }
              byPath.set(path, { _id: result.fileId as Id<"files">, type: "file" });
              lines.push(`Created ${path}`);
            }
            written.push({ name: path, content });
          }

          return lines.join("\n") + syntaxErrorNote(written) + notes.join("");
        });
      } catch (error) {
        return `Error writing files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

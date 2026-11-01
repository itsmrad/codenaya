import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { loadProjectTree, parseAgentPath } from "./paths";

interface DeleteFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z
  .object({
    paths: z.array(z.string().min(1, "Path cannot be empty")).optional(),
    fileIds: z.array(z.string().min(1, "File ID cannot be empty")).optional(),
  })
  .refine((p) => (p.paths?.length ?? 0) + (p.fileIds?.length ?? 0) > 0, {
    message: "Provide at least one path, like src/old.tsx",
  });

export const createDeleteFilesTool = ({
  projectId,
  internalKey,
}: DeleteFilesToolOptions) => {
  return createTool({
    name: "deleteFiles",
    description:
      "Delete files or folders by path. Deleting a folder deletes everything inside it.",
    parameters: z.object({
      paths: z.array(z.string()).optional().describe("Project-relative paths to delete"),
      fileIds: z
        .array(z.string())
        .optional()
        .describe("File or folder IDs to delete, if you have IDs instead of paths"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { paths = [], fileIds = [] } = parsed.data;

      try {
        // Resolved and checked inside the step: on replay after the delete, a
        // check outside it would find nothing and report an error (#292).
        return await toolStep?.run("delete-files", async () => {
          const { byPath } = await loadProjectTree(internalKey, projectId);
          const ids = [...fileIds];
          for (const raw of paths) {
            const target = parseAgentPath(raw);
            if ("error" in target) return `Error: ${target.error}`;
            const entry = byPath.get(target.path);
            if (!entry) {
              return `Error: Nothing at "${target.path}". Use listFiles to see the project's paths.`;
            }
            ids.push(entry._id);
          }

          // Check every target exists before deleting any.
          const filesToDelete: { id: Id<"files">; name: string; type: string }[] = [];
          for (const fileId of ids) {
            const file = await getFileByAgentId(internalKey, projectId, fileId);
            if (!file) {
              return `Error: File with ID "${fileId}" not found. Use listFiles to see the project's paths.`;
            }
            filesToDelete.push({ id: file._id, name: file.name, type: file.type });
          }

          const results: string[] = [];
          for (const file of filesToDelete) {
            await convex.mutation(api.system.deleteFile, {
              internalKey,
              projectId,
              fileId: file.id,
            });
            results.push(`Deleted ${file.type} "${file.name}" successfully`);
          }

          return results.join("\n");
        });
      } catch (error) {
        return `Error deleting files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

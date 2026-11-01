import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { findProjectFile, getProjectFiles, indexProjectFiles } from "./paths";

interface DeleteFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

// `fileIds` is not offered to the model; it reads tool calls made before #292.
const paramsSchema = z
  .object({
    paths: z.array(z.string()).optional(),
    fileIds: z.array(z.string()).optional(),
  })
  .refine(({ paths, fileIds }) => (paths ?? fileIds ?? []).length > 0, "Provide at least one path");

export const createDeleteFilesTool = ({
  projectId,
  internalKey,
}: DeleteFilesToolOptions) => {
  return createTool({
    name: "deleteFiles",
    description:
      "Delete files or folders from the project. If deleting a folder, all contents will be deleted recursively.",
    parameters: z.object({
      paths: z
        .array(z.string())
        .describe('Project-relative paths of the files or folders to delete, like "src/old.tsx"'),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { paths, fileIds } = parsed.data;
      const refs = paths ? paths.map((path) => ({ path })) : (fileIds ?? []).map((fileId) => ({ fileId }));

      try {
        return await toolStep?.run("delete-files", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          // Resolve every target before deleting any, so one bad path deletes nothing.
          const targets = [];
          for (const ref of refs) {
            const found = findProjectFile(index, ref);
            if ("error" in found) return found.error;
            targets.push(found);
          }

          const results: string[] = [];
          for (const { file, path } of targets) {
            await convex.mutation(api.system.deleteFile, {
              internalKey,
              projectId,
              fileId: file._id,
            });

            results.push(`Deleted ${file.type} "${path}" successfully`);
          }

          return results.join("\n");
        });
      } catch (error) {
        return `Error deleting files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

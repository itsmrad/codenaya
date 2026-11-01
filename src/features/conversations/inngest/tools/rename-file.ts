import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { resolveFileRef } from "./paths";

interface RenameFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z.object({
    path: z.string().min(1, "Path cannot be empty").optional(),
    fileId: z.string().min(1, "File ID cannot be empty").optional(),
  newName: z.string().min(1, "New name is required"),
});

export const createRenameFileTool = ({
  projectId,
  internalKey,
}: RenameFileToolOptions) => {
  return createTool({
    name: "renameFile",
    description: "Rename a file or folder, found by path. newName is the new name only, not a path",
    parameters: z.object({
      path: z.string().optional().describe("Project-relative path, like src/App.tsx"),
      fileId: z.string().optional().describe("The file or folder's ID, if you have an ID instead of a path"),
      newName: z.string().describe("The new name for the file or folder"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { newName } = parsed.data;

      try {
        // Resolved inside the step: see resolveFileRef.
        return await toolStep?.run("rename-file", async () => {
          const ref = await resolveFileRef(internalKey, projectId, parsed.data);
          if ("error" in ref) return `Error: ${ref.error}`;

          const file = await getFileByAgentId(internalKey, projectId, ref.fileId);
          if (!file) {
            return `Error: File with ID "${ref.fileId}" not found. Use listFiles to see the project's paths.`;
          }

          await convex.mutation(api.system.renameFile, {
            internalKey,
            projectId,
            fileId: file._id,
            newName,
          });

          return `Renamed "${file.name}" to "${newName}" successfully`;
        });
      } catch (error) {
        return `Error renaming file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { findProjectFile, getProjectFiles, indexProjectFiles, isSecretPath, lockedPathError, secretPathError } from "./paths";

interface RenameFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  messageId?: Id<"messages">;
}

// `fileId` is not offered to the model; it reads tool calls made before #292.
const paramsSchema = z.object({
  path: z.string().optional(),
  fileId: z.string().optional(),
  newName: z.string().min(1, "New name is required"),
});

export const createRenameFileTool = ({
  projectId,
  internalKey,
  messageId,
}: RenameFileToolOptions) => {
  return createTool({
    name: "renameFile",
    description: "Rename a file or folder in place (same parent folder)",
    parameters: z.object({
      path: z.string().describe('Project-relative path of the file or folder, like "src/App.tsx"'),
      newName: z.string().describe("The new name, without a folder path"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { newName } = parsed.data;
      // Into a protected name too, or a file the agent wrote would become one.
      if (isSecretPath(newName)) return secretPathError(newName);

      try {
        return await toolStep?.run("rename-file", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const found = await findProjectFile(internalKey, projectId, index, parsed.data);
          if ("error" in found) return found.error;
          const locked = lockedPathError(index, found.path, true);
          if (locked) return `Error: ${locked}`;

          await convex.mutation(api.system.renameFile, {
            messageId,
            internalKey,
            projectId,
            fileId: found.file._id,
            newName,
          });

          return `Renamed "${found.path}" to "${newName}" successfully`;
        })
      } catch (error) {
        return `Error renaming file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

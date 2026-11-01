import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { resolveFileRef } from "./paths";
import { syntaxErrorNote } from "./syntax-error";

interface UpdateFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z.object({
    path: z.string().min(1, "Path cannot be empty").optional(),
    fileId: z.string().min(1, "File ID cannot be empty").optional(),
  content: z.string(),
});

export const createUpdateFileTool = ({
  projectId,
  internalKey,
}: UpdateFileToolOptions) => {
  return createTool({
    name: "updateFile",
    description: "Replace the whole content of an existing file, found by path",
    parameters: z.object({
      path: z.string().optional().describe("Project-relative path, like src/App.tsx"),
      fileId: z.string().optional().describe("The file's ID, if you have an ID instead of a path"),
      content: z.string().describe("The new content for the file"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { content } = parsed.data;

      try {
        // Resolved inside the step: see resolveFileRef.
        return await toolStep?.run("update-file", async () => {
          const ref = await resolveFileRef(internalKey, projectId, parsed.data);
          if ("error" in ref) {
            return `Error: ${ref.error}. To create a new file, use writeFiles.`;
          }

          const file = await getFileByAgentId(internalKey, projectId, ref.fileId);
          if (!file) {
            return `Error: File with ID "${ref.fileId}" not found. Use listFiles to see the project's paths.`;
          }
          if (file.type === "folder") {
            return `Error: "${file.name}" is a folder, not a file. You can only update file contents.`;
          }

          await convex.mutation(api.system.updateFile, {
            internalKey,
            projectId,
            fileId: file._id,
            content,
          });

          return (
            `File "${file.name}" updated successfully` +
            syntaxErrorNote([{ name: file.name, content }])
          );
        });
      } catch (error) {
        return `Error update file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

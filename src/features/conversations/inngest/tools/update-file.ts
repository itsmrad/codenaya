import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { checkPackageVersions } from "./package-versions";
import { findProjectFile, getProjectFiles, indexProjectFiles } from "./paths";
import { syntaxErrorNote } from "./syntax-error";

interface UpdateFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

// `fileId` is not offered to the model; it reads tool calls made before #292.
const paramsSchema = z.object({
  path: z.string().optional(),
  fileId: z.string().optional(),
  content: z.string(),
});

export const createUpdateFileTool = ({
  projectId,
  internalKey,
}: UpdateFileToolOptions) => {
  return createTool({
    name: "updateFile",
    description: "Replace the content of an existing file",
    parameters: z.object({
      path: z.string().describe('Project-relative path of the file, like "src/App.tsx"'),
      content: z.string().describe("The new content for the file"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { content } = parsed.data;

      try {
        return await toolStep?.run("update-file", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const found = await findProjectFile(internalKey, projectId, index, parsed.data);
          if ("error" in found) return found.error;
          const { file, path } = found;

          if (file.type === "folder") {
            return `Error: "${path}" is a folder, not a file. You can only update file contents.`;
          }

          const { content: checkedContent, note: versionNote } = checkPackageVersions(file.name, content);

          await convex.mutation(api.system.updateFile, {
            internalKey,
            projectId,
            fileId: file._id,
            content: checkedContent,
          });

          return (
            `File "${path}" updated successfully` +
            syntaxErrorNote([{ name: path, content }]) +
            versionNote
          );
        })
      } catch (error) {
        return `Error update file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

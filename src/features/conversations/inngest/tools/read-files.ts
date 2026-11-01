import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { findProjectFile, getProjectFiles, indexProjectFiles } from "./paths";

interface ReadFilesToolOptions {
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

export const createReadFilesTool = ({
  projectId,
  internalKey,
}: ReadFilesToolOptions) => {
  return createTool({
    name: "readFiles",
    description: "Read the content of files from the project. Returns each file's path and content.",
    parameters: z.object({
      paths: z
        .array(z.string())
        .describe('Project-relative paths of the files to read, like "src/App.tsx"'),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { paths, fileIds } = parsed.data;
      const refs = paths ? paths.map((path) => ({ path })) : (fileIds ?? []).map((fileId) => ({ fileId }));

      try {
        return await toolStep?.run("read-files", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const results: { path: string; content: string }[] = [];
          const errors: string[] = [];

          for (const ref of refs) {
            const found = findProjectFile(index, ref);
            if ("error" in found) {
              errors.push(found.error);
              continue;
            }
            if (found.file.type === "folder") {
              errors.push(`Error: "${found.path}" is a folder; read the files inside it.`);
              continue;
            }
            const file = await getFileByAgentId(internalKey, projectId, found.file._id);
            if (typeof file?.content === "string") {
              results.push({ path: found.path, content: file.content });
            } else {
              errors.push(`Error: "${found.path}" has no text content.`);
            }
          }

          if (results.length === 0) {
            return errors.join("\n");
          }
          return [JSON.stringify(results), ...errors].join("\n");
        })
      } catch (error) {
        return `Error reading files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

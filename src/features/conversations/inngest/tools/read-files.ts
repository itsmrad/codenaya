import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { loadProjectTree, parseAgentPath } from "./paths";

interface ReadFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const paramsSchema = z
  .object({
    paths: z.array(z.string().min(1, "Path cannot be empty")).optional(),
    fileIds: z.array(z.string().min(1, "File ID cannot be empty")).optional(),
  })
  .refine((p) => (p.paths?.length ?? 0) + (p.fileIds?.length ?? 0) > 0, {
    message: "Provide at least one path, like src/App.tsx",
  });

export const createReadFilesTool = ({
  projectId,
  internalKey,
}: ReadFilesToolOptions) => {
  return createTool({
    name: "readFiles",
    description: "Read files by path, like src/App.tsx. Returns each file's path and content.",
    parameters: z.object({
      paths: z.array(z.string()).optional().describe("Project-relative file paths to read"),
      fileIds: z.array(z.string()).optional().describe("File IDs to read, if you have IDs instead of paths"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { paths = [], fileIds = [] } = parsed.data;

      try {
        return await toolStep?.run("read-files", async () => {
          const { byPath, pathOf } = await loadProjectTree(internalKey, projectId);
          const missing: string[] = [];
          const ids = [...fileIds];
          for (const raw of paths) {
            const target = parseAgentPath(raw);
            const entry = "path" in target ? byPath.get(target.path) : undefined;
            if (entry) ids.push(entry._id);
            else missing.push("error" in target ? target.error : `Nothing at "${target.path}"`);
          }

          const results: { id: string; path: string; content: string }[] = [];
          for (const fileId of ids) {
            const file = await getFileByAgentId(internalKey, projectId, fileId);
            if (file && file.content) {
              results.push({ id: file._id, path: pathOf(file._id) ?? file.name, content: file.content });
            }
          }

          if (results.length === 0) {
            return `Error: No files found${missing.length ? ` (${missing.join("; ")})` : ""}. Use listFiles to see the project's paths.`;
          }

          return JSON.stringify(missing.length ? { files: results, missing } : results);
        });
      } catch (error) {
        return `Error reading files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

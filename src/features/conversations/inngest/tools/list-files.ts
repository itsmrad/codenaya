import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { Id } from "../../../../../convex/_generated/dataModel";
import { getProjectFiles, indexProjectFiles, listProjectPaths } from "./paths";

interface ListFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

export const createListFilesTool = ({
  projectId,
  internalKey,
}: ListFilesToolOptions) => {
  return createTool({
    name: "listFiles",
    description:
      'List every file and folder in the project as sorted project-relative paths; folders end in "/".',
    parameters: z.object({
      withIds: z
        .boolean()
        .describe("Also return each item's ID. Only the legacy createFiles and createFolder tools need IDs; pass false."),
    }),
    handler: async (params, { step: toolStep }) => {
      try {
        return await toolStep?.run("list-files", async () => {
          const files = await getProjectFiles(internalKey, projectId);
          if ((params as { withIds?: unknown }).withIds !== true) {
            return listProjectPaths(files).join("\n") || "The project is empty.";
          }
          const { pathOf } = indexProjectFiles(files);
          return JSON.stringify(
            files
              .flatMap((f) => {
                const path = pathOf(f._id);
                return path ? [{ path: f.type === "folder" ? `${path}/` : path, id: f._id }] : [];
              })
              .sort((a, b) => (a.path < b.path ? -1 : 1)),
          );
        })
      } catch (error) {
        return `Error listing files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

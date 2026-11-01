import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { Id } from "../../../../../convex/_generated/dataModel";
import { loadProjectTree } from "./paths";

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
      "List every file and folder in the project as sorted paths, one per line. Folders end in /. Set withIds to also get each item's ID, which only createFiles and createFolder need.",
    parameters: z.object({
      withIds: z.boolean().optional().describe("Also return each item's ID"),
    }),
    handler: async ({ withIds }, { step: toolStep }) => {
      try {
        return await toolStep?.run("list-files", async () => {
          const { byPath } = await loadProjectTree(internalKey, projectId);
          if (byPath.size === 0) return "The project is empty.";
          return [...byPath]
            .map(([path, { _id, type }]) => {
              const shown = type === "folder" ? `${path}/` : path;
              return withIds ? `${shown} (${_id})` : shown;
            })
            .sort()
            .join("\n");
        });
      } catch (error) {
        return `Error listing files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { createRegistryCheck, postWriteNote, getIconRewriter, type RegistryCheck } from "./post-write-checks";
import { syntaxErrorNote } from "./syntax-error";

interface CreateFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  registry?: RegistryCheck;
}

const paramsSchema = z.object({
  parentId: z.string(),
  files: z
    .array(
      z.object({
        name: z.string().min(1, "File name cannot be empty"),
        content: z.string(),
      })
    )
    .min(1, "Provide at least one file to create"),
});

export const createCreateFilesTool = ({
  projectId,
  internalKey,
  registry = createRegistryCheck(),
}: CreateFilesToolOptions) => {
  return createTool({
    name: "createFiles",
    description:
      "Legacy: prefer writeFiles, which takes paths. Create multiple files at once in the same folder. Use this to batch create files that share the same parent folder. More efficient than creating files one by one.",
    parameters: z.object({
      parentId: z
        .string()
        .describe(
          "The ID of the parent folder. Use empty string for root level. Must be a valid folder ID from listFiles."
        ),
      files: z
        .array(
          z.object({
            name: z.string().describe("The file name including extension"),
            content: z.string().describe("The file content"),
          })
        )
        .describe("Array of files to create"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { parentId } = parsed.data;


      try {
        return await toolStep?.run("create-files", async () => {
          let resolvedParentId: Id<"files"> | undefined;

          if (parentId && parentId !== "") {
            try {
              resolvedParentId = parentId as Id<"files">;
              const parentFolder = await convex.query(api.system.getFileById, {
                internalKey,
                projectId,
                fileId: resolvedParentId,
              });
              if (!parentFolder) {
                return `Error: Parent folder not found. Prefer writeFiles, which takes paths.`;
              }
              if (parentFolder.type !== "folder") {
                return `Error: "${parentFolder.name}" is a file, not a folder. Use a folder ID as parentId.`;
              }
            } catch {
              return `Error: Invalid parentId. Prefer writeFiles, which takes paths.`;
            }
          }

          const rewriteIcons = await getIconRewriter(internalKey, projectId,
            resolvedParentId ? [] : parsed.data.files.map((file) => ({ path: file.name, content: file.content })));
          const prepared = parsed.data.files.map((file) => ({ ...file, ...rewriteIcons(file.content, file.name) }));
          const files = prepared.map(({ name, content }) => ({ name, content }));
          const results = await convex.mutation(api.system.createFiles, {
            internalKey,
            projectId,
            parentId: resolvedParentId,
            files,
          });

          const created = results.filter((r) => !r.error);
          const failed = results.filter((r) => r.error);

          let response = `Created ${created.length} file(s)`;
          if (created.length > 0) {
            response += `: ${created.map((r) => r.name).join(", ")}`;
          }
          if (failed.length > 0) {
            response += `. Failed: ${failed.map((r) => `${r.name} (${r.error})`).join(", ")}`;
          }

          return (
            response +
            syntaxErrorNote(files.filter((file) => created.some((r) => r.name === file.name))) +
            await postWriteNote(internalKey, projectId, created.flatMap((r) => r.fileId ? [r.fileId] : []), registry,
              prepared.filter((f) => created.some((r) => r.name === f.name)).flatMap((f) => f.rewrites))
          );
        });
      } catch (error) {
        return `Error creating files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { findProjectFile, getProjectFiles, indexProjectFiles, normalizePath } from "./paths";

interface ReadFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const rangesSchema = z.array(z.object({
  path: z.string().refine((path) => normalizePath(path) !== undefined, "Invalid range path"),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
}).refine(({ startLine, endLine }) => endLine === undefined || endLine >= (startLine ?? 1),
  "endLine must be at least startLine"));

// `fileIds` is not offered to the model; it reads tool calls made before #292.
const paramsSchema = z
  .object({
    paths: z.array(z.string()).optional(),
    fileIds: z.array(z.string()).optional(),
    ranges: rangesSchema.optional(),
  })
  .refine(({ paths, fileIds }) => (paths ?? fileIds ?? []).length > 0, "Provide at least one path")
  .refine(({ paths, ranges }) => (ranges ?? []).every((range) =>
    (paths ?? []).some((path) => normalizePath(path) === normalizePath(range.path)),
  ), "Every ranges path must also be included in paths");

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
      ranges: rangesSchema.optional().describe("Optional inclusive 1-based ranges keyed by path. Every range path must also be in paths, otherwise returns Error. Only the first range per path is used. Only ranged reads include line numbers; do not copy the numbers into file writes."),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { paths, fileIds, ranges = [] } = parsed.data;
      const refs = paths ? paths.map((path) => ({ path })) : (fileIds ?? []).map((fileId) => ({ fileId }));

      try {
        return await toolStep?.run("read-files", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const results: { path: string; content: string }[] = [];
          const errors: string[] = [];
          const ranged: string[] = [];

          for (const ref of refs) {
            const found = await findProjectFile(internalKey, projectId, index, ref);
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
              const range = ranges.find((range) => normalizePath(range.path) === found.path);
              if (!range) {
                results.push({ path: found.path, content: file.content });
              } else {
                const lines = file.content.split(/\r?\n/);
                const start = Math.min(range.startLine ?? 1, lines.length);
                const end = Math.min(range.endLine ?? lines.length, lines.length);
                const clamped = start !== (range.startLine ?? 1) || end !== (range.endLine ?? lines.length);
                ranged.push([
                  `File: ${found.path} (lines ${start}-${end} of ${lines.length})`,
                  ...(clamped ? ["Note: requested range clamped to file bounds."] : []),
                  ...lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`),
                ].join("\n"));
              }
            } else {
              errors.push(`Error: "${found.path}" has no text content.`);
            }
          }

          if (results.length === 0 && ranged.length === 0) {
            return errors.join("\n");
          }
          return [...(results.length ? [JSON.stringify(results)] : []), ...ranged, ...errors].join("\n");
        })
      } catch (error) {
        return `Error reading files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
  });
};

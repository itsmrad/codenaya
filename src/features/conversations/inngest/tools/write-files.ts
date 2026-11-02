import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import {
  folderEnsurer,
  folderPaths,
  getProjectFiles,
  indexProjectFiles,
  invalidPathError,
  normalizePath,
  splitPath,
} from "./paths";
import { createRegistryCheck, postWriteNote, getIconRewriter, type RegistryCheck } from "./post-write-checks";
import { syntaxErrorNote } from "./syntax-error";

interface WriteFilesToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  registry?: RegistryCheck;
}

const paramsSchema = z.object({
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .min(1, "Provide at least one file to write"),
});

export const createWriteFilesTool = ({ projectId, internalKey, registry = createRegistryCheck() }: WriteFilesToolOptions) => {
  return createTool({
    name: "writeFiles",
    description:
      "Create or overwrite files by path. Missing parent folders are created, so write a whole feature in one call: files in any folders, new or existing.",
    parameters: z.object({
      files: z
        .array(
          z.object({
            path: z.string().describe('Project-relative path, like "src/components/ui/button.tsx"'),
            content: z.string().describe("The complete file content"),
          }),
        )
        .describe("The files to write"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      try {
        return await toolStep?.run("write-files", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const ensureFolder = folderEnsurer(internalKey, projectId, folderPaths(index));

          const failed: string[] = [];
          // Everything is checked before the first write. A path listed twice
          // is written once, with its last content, like two writes in a row.
          const batch = new Map<string, string>();
          for (const { path: raw, content } of parsed.data.files) {
            const path = normalizePath(raw);
            if (path === undefined) {
              failed.push(invalidPathError(raw).replace(/^Error: /, ""));
            } else if (raw.trim().endsWith("/")) {
              failed.push(`${path}/ (ends in "/", so it names a folder; write to a file path)`);
            } else {
              batch.set(path, content);
            }
          }

          const updates: { path: string; fileId: Id<"files">; content: string }[] = [];
          const createsByDir = new Map<string, { name: string; content: string }[]>();
          for (const [path, content] of batch) {
            const entry = index.byPath.get(path);
            const { dir, name } = splitPath(path);
            // A folder can't become a file, and a file can't hold one (#267).
            // In one call, a path that another path needs as a folder is the
            // one refused, whichever comes first.
            const holdsBatchPath = [...batch.keys()].some((other) => other.startsWith(`${path}/`));
            const blocker = dir
              .split("/")
              .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
              .find((ancestor) => {
                const at = index.byPath.get(ancestor);
                return at?.file && !at.folder;
              });
            if (entry?.folder && !entry.file) {
              failed.push(`${path} (a folder; write to a file path inside it)`);
            } else if (holdsBatchPath) {
              failed.push(`${path} (also a folder of another path in this call)`);
            } else if (blocker) {
              failed.push(`${path} ("${blocker}" is a file, not a folder)`);
            } else if (entry?.file) {
              updates.push({ path, fileId: entry.file._id, content });
            } else {
              createsByDir.set(dir, [...(createsByDir.get(dir) ?? []), { name, content }]);
            }
          }

          const rewriteIcons = await getIconRewriter(internalKey, projectId, [
            ...updates.map(({ path, content }) => ({ path, content })),
            ...[...createsByDir].flatMap(([dir, files]) => files.map(({ name, content }) => ({ path: dir ? `${dir}/${name}` : name, content }))),
          ]);
          const rewritesByPath = new Map<string, string[]>();
          for (const update of updates) {
            const fixed = rewriteIcons(update.content, update.path);
            update.content = fixed.content;
            batch.set(update.path, fixed.content);
            rewritesByPath.set(update.path, fixed.rewrites);
          }
          for (const [dir, files] of createsByDir) for (const file of files) {
            const path = dir ? `${dir}/${file.name}` : file.name;
            const fixed = rewriteIcons(file.content, path);
            file.content = fixed.content;
            batch.set(path, fixed.content);
            rewritesByPath.set(path, fixed.rewrites);
          }
          const writtenIds: string[] = updates.map((u) => u.fileId);
          const created: string[] = [];
          const createIn = async (dir: string, files: { name: string; content: string }[]) => {
            const results = await convex.mutation(api.system.createFiles, {
              internalKey,
              projectId,
              parentId: await ensureFolder(dir),
              files,
            });
            for (const result of results) {
              const path = dir ? `${dir}/${result.name}` : result.name;
              if (result.error) failed.push(`${path} (${result.error})`);
              else {
                created.push(path);
                writtenIds.push(result.fileId!);
              }
            }
          };

          // Root files last: the preview starts booting once package.json
          // exists, so it must land with (not before) the files it uses (#254).
          for (const [dir, files] of createsByDir) {
            if (dir) await createIn(dir, files);
          }
          for (const { fileId, content } of updates) {
            await convex.mutation(api.system.updateFile, { internalKey, projectId, fileId, content });
          }
          const rootFiles = createsByDir.get("");
          if (rootFiles) await createIn("", rootFiles);

          const updated = updates.map(({ path }) => path);
          const written = new Set([...created, ...updated]);
          if (written.size === 0) return `Error: No files written. Failed: ${failed.join(", ")}.`;
          return (
            [
              `Wrote ${written.size} file(s).`,
              created.length > 0 ? `Created: ${created.join(", ")}.` : "",
              updated.length > 0 ? `Updated: ${updated.join(", ")}.` : "",
              failed.length > 0 ? `Failed: ${failed.join(", ")}.` : "",
            ]
              .filter(Boolean)
              .join(" ") +
            syntaxErrorNote(
              [...batch]
                .filter(([path]) => written.has(path))
                .map(([name, content]) => ({ name, content })),
            ) +
            await postWriteNote(internalKey, projectId, writtenIds, registry, [...written].flatMap((path) => rewritesByPath.get(path) ?? []))
          );
        });
      } catch (error) {
        return `Error writing files: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

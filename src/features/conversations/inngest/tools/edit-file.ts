import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { findProjectFile, getProjectFiles, indexProjectFiles } from "./paths";
import { checkPackageVersions } from "./package-versions";
import { syntaxErrorNote } from "./syntax-error";

interface EditFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
}

const editSchema = z.object({
  oldText: z.string().min(1, "oldText must not be empty"),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});

// `fileId` is not offered to the model; it reads tool calls made before #292.
const paramsSchema = z.object({
  path: z.string().optional(),
  fileId: z.string().optional(),
  edits: z.array(editSchema).min(1, "At least one edit is required"),
});

export type FileEdit = z.infer<typeof editSchema>;

/**
 * Applies search/replace edits in order (#291). All or nothing: the first edit
 * that does not match exactly once (or at least once, with `replaceAll`) fails
 * the whole call. Line endings are matched as LF and the file keeps its own.
 */
export const applyEdits = (
  content: string,
  edits: FileEdit[],
): { content: string } | { error: string } => {
  const crlf = content.includes("\r\n");
  const lf = (text: string) => text.replace(/\r\n/g, "\n");
  let next = lf(content);

  for (const [index, edit] of edits.entries()) {
    const oldText = lf(edit.oldText);
    const newText = lf(edit.newText);
    const matches = next.split(oldText).length - 1;
    const label = `oldText #${index + 1}`;
    if (matches === 0) {
      return { error: `${label} matched 0 times; re-read the file with readFiles and copy the text exactly` };
    }
    if (matches > 1 && !edit.replaceAll) {
      return { error: `${label} matched ${matches} times; include more surrounding lines, or set replaceAll` };
    }
    next = next.split(oldText).join(newText);
  }

  return { content: crlf ? next.replace(/\n/g, "\r\n") : next };
};

export const createEditFileTool = ({ projectId, internalKey }: EditFileToolOptions) => {
  return createTool({
    name: "editFile",
    description:
      "Edit part of an existing file by replacing exact text. Each oldText must match exactly once (unless replaceAll is set); edits apply in order, and if any edit fails nothing is written. Prefer this over updateFile for changes that leave most of the file as it is.",
    parameters: z.object({
      path: z.string().describe('Project-relative path of the file, like "src/App.tsx"'),
      edits: z
        .array(
          z.object({
            oldText: z.string().describe("Exact text to replace, with enough surrounding lines to be unique"),
            newText: z.string().describe("The text to put in its place"),
            replaceAll: z.boolean().optional().describe("Replace every match instead of requiring exactly one"),
          }),
        )
        .describe("Edits to apply in order"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      const { edits } = parsed.data;

      try {
        // Read, match and write in one step: on replay the handler runs again,
        // and a read outside the step would see the already edited file.
        return await toolStep?.run("edit-file", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const found = await findProjectFile(internalKey, projectId, index, parsed.data);
          if ("error" in found) return found.error;
          const { file, path } = found;
          if (file.type === "folder") {
            return `Error: "${path}" is a folder, not a file. You can only edit file contents.`;
          }

          // The file list carries no text, so read it.
          const text = (await getFileByAgentId(internalKey, projectId, file._id))?.content;
          if (text === undefined) {
            return `Error: "${path}" has no text content to edit (it may be a binary file).`;
          }

          const result = applyEdits(text, edits);
          if ("error" in result) {
            return `Error: ${result.error}. Nothing was written to "${path}".`;
          }

          // Same known-good versions as createFiles and updateFile (#331).
          const { content, note: versionNote } = checkPackageVersions(file.name, result.content);

          await convex.mutation(api.system.updateFile, {
            internalKey,
            projectId,
            fileId: file._id,
            content,
          });

          return (
            `File "${path}" edited successfully (${edits.length} edit${edits.length === 1 ? "" : "s"})` +
            syntaxErrorNote([{ name: path, content }]) +
            versionNote
          );
        });
      } catch (error) {
        return `Error editing file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

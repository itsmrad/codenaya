import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { checkPackageVersions } from "./package-versions";
import { findProjectFile, getProjectFiles, indexProjectFiles } from "./paths";
import { createRegistryCheck, postWriteNote, getIconRewriter, type RegistryCheck } from "./post-write-checks";
import { syntaxErrorNote } from "./syntax-error";

interface EditFileToolOptions {
  projectId: Id<"projects">;
  internalKey: string;
  registry?: RegistryCheck;
}

const editSchema = z.object({
  oldText: z.string().describe("Exact text to find, including whitespace and indentation"),
  newText: z.string().describe("Text to put in its place"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every match instead of requiring exactly one"),
});

type Edit = z.infer<typeof editSchema>;

const paramsSchema = z.object({
  path: z.string(),
  edits: z.array(editSchema).min(1, "Provide at least one edit"),
});

const toLf = (text: string) => text.replace(/\r\n/g, "\n");

/** Matches of `search` in `text`, overlapping ones included: "aba" is in "ababa" twice. */
const countMatches = (text: string, search: string) => {
  let count = 0;
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + 1)) {
    count += 1;
  }
  return count;
};

/**
 * Applies `edits` in order, each to the result of the one before. All or
 * nothing: the first edit that doesn't match exactly once (or at least once
 * with `replaceAll`) fails the whole call, as does a result equal to `content`.
 * Edit text is matched with the file's line ending, so a CRLF file stays CRLF;
 * a file mixing CRLF and LF is refused rather than having its endings changed.
 */
export const applyEdits = (
  content: string,
  edits: Edit[],
): { content: string } | { error: string } => {
  const crlf = content.includes("\r\n");
  if (crlf && /(^|[^\r])\n/.test(content)) {
    return { error: "the file mixes CRLF and LF line endings, so editFile can't match it safely; rewrite it with updateFile." };
  }
  const withEol = (raw: string) => (crlf ? toLf(raw).replace(/\n/g, "\r\n") : toLf(raw));
  let text = content;

  for (const [i, edit] of edits.entries()) {
    const label = `oldText #${i + 1}`;
    const oldText = withEol(edit.oldText);
    const newText = withEol(edit.newText);
    if (!oldText) return { error: `${label} is empty; copy the exact text to replace from the file.` };

    const matches = countMatches(text, oldText);
    if (matches === 0) {
      return {
        error: `${label} matched 0 times${i > 0 ? " (after the earlier edits)" : ""}; re-read the file and copy the text exactly.`,
      };
    }
    if (matches > 1 && !edit.replaceAll) {
      return {
        error: `${label} matched ${matches} times; include more surrounding lines so it matches once, or set replaceAll.`,
      };
    }
    // split/join, not String.replace: newText may hold "$&"-style patterns.
    if (edit.replaceAll) {
      text = text.split(oldText).join(newText);
    } else {
      const at = text.indexOf(oldText);
      text = text.slice(0, at) + newText + text.slice(at + oldText.length);
    }
  }

  if (text === content) {
    return { error: "the edits leave the file unchanged; make each newText differ from its oldText." };
  }
  return { content: text };
};

export const createEditFileTool = ({ projectId, internalKey, registry = createRegistryCheck() }: EditFileToolOptions) => {
  return createTool({
    name: "editFile",
    description:
      "Edit an existing file by replacing exact snippets. Each oldText must match exactly once (unless replaceAll); edits apply in order, and if any fails nothing is written. Prefer this over updateFile for changes to part of a file.",
    parameters: z.object({
      path: z.string().describe('Project-relative path of the file, like "src/App.tsx"'),
      edits: z.array(editSchema).describe("Replacements to apply in order"),
    }),
    handler: async (params, { step: toolStep }) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return `Error: ${parsed.error.issues[0].message}`;
      }

      try {
        return await toolStep?.run("edit-file", async () => {
          const index = indexProjectFiles(await getProjectFiles(internalKey, projectId));
          const found = await findProjectFile(internalKey, projectId, index, parsed.data);
          if ("error" in found) return found.error;
          const { file, path } = found;

          if (file.type === "folder") {
            return `Error: "${path}" is a folder, not a file. You can only edit file contents.`;
          }
          const current = await getFileByAgentId(internalKey, projectId, file._id);
          if (typeof current?.content !== "string") {
            return `Error: "${path}" has no text content.`;
          }

          const result = applyEdits(current.content, parsed.data.edits);
          if ("error" in result) {
            return `Error: ${result.error} "${path}" was not changed.`;
          }

          const { content: checkedContent, note: versionNote } = checkPackageVersions(file.name, result.content);

          const rewriteIcons = await getIconRewriter(internalKey, projectId, [{ path, content: checkedContent }]);
          const prepared = rewriteIcons(checkedContent, path);
          result.content = prepared.content;
          await convex.mutation(api.system.updateFile, {
            internalKey,
            projectId,
            fileId: file._id,
            content: result.content,
          });

          return (
            `File "${path}" edited successfully` +
            syntaxErrorNote([{ name: path, content: result.content }]) +
            versionNote +
            await postWriteNote(internalKey, projectId, [file._id], registry, prepared.rewrites)
          );
        });
      } catch (error) {
        return `Error editing file: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    },
  });
};

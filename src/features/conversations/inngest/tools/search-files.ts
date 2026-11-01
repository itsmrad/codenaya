import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { MAX_SEARCH_RESULTS } from "../../file-search";

// Convex's execution/read-limit messages; network timeouts and other failures must retry.
const searchLimitError = /Function execution timed out|Your request timed out performing too many system operations|Too many (?:bytes read|documents read|reads) in a single function execution|\b(?:TooManyBytesRead|TooManyDocumentsRead|TooManyReads)\b/;

const parameters = z.object({
  pattern: z.string().min(1).max(500),
  isRegex: z.boolean().optional().describe("Use RE2 regex syntax. Default false (literal). Regex searches inspect only the first 4,000 characters of each line."),
  pathGlob: z.string().max(500).optional().describe('Project-relative glob supporting *, **, ?. Example: "src/**/*.tsx".'),
  maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional().describe("Maximum matching lines, default 50."),
});

export const createSearchFilesTool = (options: { projectId: Id<"projects">; internalKey: string }) =>
  createTool({
    name: "searchFiles",
    description: "Search project text files for usages before editing. Returns path:line: text, with explicit truncation when limited. Binary files are skipped. Regex matching checks only the first 4,000 characters of each line; literal search checks entire lines.",
    parameters,
    handler: async (params, { step }) => {
      const parsed = parameters.safeParse(params);
      if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;
      return await step?.run("search-files", async () => {
        try {
          return await convex.query(api.files.searchFiles, { ...options, ...parsed.data });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[searchFiles] query failed", options.internalKey
            ? message.replaceAll(options.internalKey, "[redacted]") : message);
          if (!searchLimitError.test(message)) throw error;
          // Persist execution/read-limit errors so the same expensive query is not retried.
          return "Error: search too expensive; narrow pathGlob or use a literal pattern";
        }
      });
    },
  });

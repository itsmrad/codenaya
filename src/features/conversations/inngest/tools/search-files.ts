import { z } from "zod";
import { createTool } from "@inngest/agent-kit";

import { convex } from "@/lib/convex-client";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { MAX_SEARCH_RESULTS } from "../../file-search";

const parameters = z.object({
  pattern: z.string().min(1).max(500),
  isRegex: z.boolean().optional().describe("Use RE2 regex syntax. Default false (literal)."),
  pathGlob: z.string().max(500).optional().describe('Project-relative glob supporting *, **, ?. Example: "src/**/*.tsx".'),
  maxResults: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional().describe("Maximum matching lines, default 50."),
});

export const createSearchFilesTool = (options: { projectId: Id<"projects">; internalKey: string }) =>
  createTool({
    name: "searchFiles",
    description: "Search project text files for usages before editing. Returns path:line: text, with explicit truncation when limited. Binary files are skipped.",
    parameters,
    handler: async (params, { step }) => {
      const parsed = parameters.safeParse(params);
      if (!parsed.success) return `Error: ${parsed.error.issues[0].message}`;
      return await step?.run("search-files", async () => {
        try {
          return await convex.query(api.files.searchFiles, { ...options, ...parsed.data });
        } catch {
          // Persist the tool error so an expensive query is not retried by Inngest.
          return "Error: search too expensive; narrow pathGlob or use a literal pattern";
        }
      });
    },
  });

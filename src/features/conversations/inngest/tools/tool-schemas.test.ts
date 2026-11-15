import { createAgenticModelFromAiAdapter, type Tool } from "@inngest/agent-kit";
import { describe, expect, it } from "vitest";

import { buildAgentKitModel } from "@/features/ai-providers/server/agentkit-model";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { createCheckBuildTool } from "./check-build";
import { createCreateFilesTool } from "./create-files";
import { createCreateFolderTool } from "./create-folder";
import { createDeleteFilesTool } from "./delete-files";
import { createEditFileTool } from "./edit-file";
import { createListFilesTool } from "./list-files";
import { createLoadSkillTool } from "./load-skill";
import { createReadFilesTool } from "./read-files";
import { createRenameFileTool } from "./rename-file";
import { createScaffoldViteAppTool } from "./scaffold-vite-app";
import { createScrapeUrlsTool } from "./scrape-urls";
import { createSearchFilesTool } from "./search-files";
import { createSetEnvVarTool } from "./set-env-var";
import { createUpdateFileTool } from "./update-file";
import { createWriteFilesTool } from "./write-files";

const opts = { projectId: "p1" as Id<"projects">, internalKey: "k", ownerId: "u1" };

// Every tool the coding agent can be given (process-message.ts), MCP tools aside.
const agentTools: Tool.Any[] = [
  createListFilesTool(opts),
  createReadFilesTool(opts),
  createSearchFilesTool(opts),
  createWriteFilesTool(opts),
  createUpdateFileTool(opts),
  createEditFileTool(opts),
  createCreateFilesTool(opts),
  createCreateFolderTool(opts),
  createScaffoldViteAppTool(opts),
  createRenameFileTool(opts),
  createDeleteFilesTool(opts),
  createCheckBuildTool(opts),
  createScrapeUrlsTool(),
  createSetEnvVarTool(opts),
  createLoadSkillTool({ skills: [{ name: "s", description: "d", body: "b", source: "builtin" }] }),
];

/** Where a JSON schema breaks OpenAI strict function calling: every object closed, every property required. */
const strictIssues = (schema: unknown, at = "$"): string[] => {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const issues: string[] = [];
  if (node.properties && typeof node.properties === "object") {
    const required = (node.required as string[] | undefined) ?? [];
    if (node.additionalProperties !== false) issues.push(`${at}: additionalProperties is not false`);
    for (const key of Object.keys(node.properties)) {
      if (!required.includes(key)) issues.push(`${at}.${key}: optional`);
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "properties") issues.push(...strictIssues(child, `${at}.${key}`));
    else for (const [name, prop] of Object.entries(child as object)) issues.push(...strictIssues(prop, `${at}.${name}`));
  }
  return issues;
};

type SentTool = { function: { name: string; parameters?: unknown; strict?: boolean } };

describe("agent tool schemas on an OpenAI-format provider (#566)", () => {
  it.each(["openrouter", "openai", "groq", "custom"] as const)(
    "%s disables strict mode for every agent tool without rewriting schemas",
    (provider) => {
      const model = buildAgentKitModel({
        provider, apiKey: "test", model: "openai/gpt-6-luna",
        ...(provider === "custom" ? { baseUrl: "https://llm.example.com/v1" } : {}),
      });
      const body = createAgenticModelFromAiAdapter(model).requestParser(
        model,
        [{ type: "text", role: "user", content: "hi" }],
        agentTools,
        "auto",
      ) as { tools: SentTool[] };
      const parameters = structuredClone(body.tools.map((tool) => tool.function.parameters));
      (model.onCall as (adapter: unknown, body: unknown) => void)(model, body);

      expect(body.tools).toHaveLength(agentTools.length);
      expect(body.tools.every((tool) => tool.function.strict === false)).toBe(true);
      expect(body.tools.map((tool) => tool.function.parameters)).toEqual(parameters);
      const rejected = body.tools.flatMap(({ function: fn }) =>
        fn.strict ? strictIssues(fn.parameters).map((issue) => `${fn.name} ${issue}`) : [],
      );
      expect(rejected).toEqual([]);
    },
  );
});

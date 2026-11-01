import { describe, expect, it } from "vitest";

import {
  type AgentStep,
  BUILD_CHECK_UNFINISHED,
  BUILD_VERIFIED,
  STATIC_CHECKS_PASSED,
  buildPathIndex,
  describeToolCall,
  fixedBuildErrors,
  lastRunActivity,
  sanitizeAgentText,
  toolResultError,
} from "./agent-steps";

const ID_A = "j977re57j3xkq2m8d4fz6t1vn0c5ab7e";
const ID_SRC = "k57abc12def34ghi56jkl78mno90pqr1";
const paths: Record<string, string> = { [ID_A]: "src/App.jsx", [ID_SRC]: "src" };
const pathOf = (id: string) => paths[id];

describe("buildPathIndex", () => {
  it("joins nested folder names", () => {
    const pathOf = buildPathIndex([
      { _id: "a", name: "src" },
      { _id: "b", name: "app", parentId: "a" },
      { _id: "c", name: "page.tsx", parentId: "b" },
    ]);
    expect(pathOf("c")).toBe("src/app/page.tsx");
    expect(pathOf("missing")).toBeUndefined();
  });
});

describe("describeToolCall", () => {
  it("resolves file ids to paths and drops unknown ids", () => {
    expect(
      describeToolCall(
        { name: "readFiles", input: { fileIds: [ID_A, "zzz"] } },
        pathOf,
      ),
    ).toEqual(["src/App.jsx"]);
  });

  it("joins created file names onto the parent folder path", () => {
    expect(
      describeToolCall(
        {
          name: "createFiles",
          input: { parentId: ID_SRC, files: [{ name: "a.tsx", content: "x" }] },
        },
        pathOf,
      ),
    ).toEqual(["src/a.tsx"]);
  });

  it("shows rename source and new name", () => {
    expect(
      describeToolCall(
        { name: "renameFile", input: { fileId: ID_A, newName: "Main.jsx" } },
        pathOf,
      ),
    ).toEqual(["src/App.jsx", "Main.jsx"]);
  });

  it("never exposes env var values", () => {
    expect(
      describeToolCall(
        { name: "setEnvVar", input: { key: "API_URL", value: "secret" } },
        pathOf,
      ),
    ).toEqual(["API_URL"]);
  });

  it("names the loaded skill", () => {
    expect(
      describeToolCall({ name: "loadSkill", input: { name: "seo-metadata" } }, pathOf),
    ).toEqual(["seo-metadata"]);
    expect(describeToolCall({ name: "loadSkill", input: {} }, pathOf)).toEqual([]);
  });

  it("uses the tool part of namespaced MCP tools", () => {
    expect(
      describeToolCall({ name: "context7__search_docs", input: {} }, pathOf),
    ).toEqual(["search_docs"]);
  });
});

describe("toolResultError", () => {
  it("detects error strings and thrown errors", () => {
    expect(toolResultError({ data: "File updated" })).toBeUndefined();
    expect(toolResultError({ error: { message: "boom" } })).toBe("boom");
  });

  // #219: an unresolved id used to read 'File with ID "a file" not found.'
  it("resolves ids in errors to paths, and drops ids it cannot resolve", () => {
    const missing = { data: `Error: File with ID "${ID_A}" not found. Use listFiles.` };
    expect(toolResultError(missing)).toBe("Error: File not found. Use listFiles.");
    expect(toolResultError(missing, pathOf)).toBe(
      'Error: File "src/App.jsx" not found. Use listFiles.',
    );
    expect(
      toolResultError({ data: `Error: Parent folder with ID "${ID_A}" not found.` }),
    ).toBe("Error: Parent folder not found.");
  });
});

describe("sanitizeAgentText", () => {
  it("strips leaked model tokens and tool-call markup", () => {
    expect(
      sanitizeAgentText("<dots_function_call>Done<|im_end|> <tool_call>"),
    ).toBe("Done");
  });

  it("replaces document ids with paths or a neutral fallback", () => {
    expect(sanitizeAgentText(`Updated App (ID: ${ID_A}).`, pathOf)).toBe(
      "Updated App (src/App.jsx).",
    );
    expect(sanitizeAgentText(`Opened ${ID_A}`, pathOf)).toBe(
      "Opened src/App.jsx",
    );
    expect(sanitizeAgentText(`Created file ID: ${"a1".repeat(16)}.`)).toBe(
      "Created file.",
    );
  });

  it("leaves code blocks and ordinary words alone", () => {
    const code = "```\nconst id = \"" + ID_A + "\";\n```";
    expect(sanitizeAgentText(code)).toBe(code);
    expect(sanitizeAgentText("internationalization")).toBe(
      "internationalization",
    );
  });
});

describe("lastRunActivity", () => {
  it("is the run start when nothing has been recorded", () => {
    expect(lastRunActivity(1_000, [])).toBe(1_000);
  });

  it("is the latest step start or end", () => {
    expect(
      lastRunActivity(1_000, [
        { id: "a", kind: "tool", status: "done", startedAt: 2_000, endedAt: 5_000 },
        { id: "b", kind: "tool", status: "running", startedAt: 4_000 },
      ]),
    ).toBe(5_000);
  });
});

describe("fixedBuildErrors", () => {
  const check = (status: AgentStep["status"], extra: Partial<AgentStep> = {}): AgentStep => ({
    id: Math.random().toString(36),
    kind: "tool",
    tool: "checkBuild",
    status,
    startedAt: 0,
    ...extra,
  });
  const failed = check("error", { error: "Error: tsc failed" });
  const verified = check("done", { text: BUILD_VERIFIED });

  it("counts failed checks a later verified build resolved", () => {
    expect(fixedBuildErrors([failed, verified])).toBe(1);
    expect(fixedBuildErrors([failed, failed, verified])).toBe(2);
  });

  it("leaves failures with no verified build after them unresolved", () => {
    expect(fixedBuildErrors([failed, failed])).toBe(0);
    expect(fixedBuildErrors([failed, verified, failed])).toBe(1);
    expect(fixedBuildErrors([failed, check("done", { text: STATIC_CHECKS_PASSED })])).toBe(0);
  });

  it("ignores running checks, checks that could not finish and other tools", () => {
    const unfinished = check("error", { error: `${BUILD_CHECK_UNFINISHED} (timeout).` });
    const otherTool: AgentStep = { ...failed, tool: "updateFile" };
    expect(fixedBuildErrors([check("running"), unfinished, otherTool, verified])).toBe(0);
  });
});

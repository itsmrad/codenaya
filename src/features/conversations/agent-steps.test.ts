import { describe, expect, it } from "vitest";

import {
  type AgentStep,
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  STATIC_CHECKS_PASSED,
  buildPathIndex,
  describeToolCall,
  fixedBuildErrors,
  lastRunActivity,
  runWrittenPaths,
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

  it("names the edited file's path", () => {
    expect(
      describeToolCall(
        { name: "editFile", input: { path: "src/App.jsx", edits: [{ oldText: "a", newText: "b" }] } },
        pathOf,
      ),
    ).toEqual(["src/App.jsx"]);
  });

  it("names path inputs (#292), normalized and without invalid ones", () => {
    expect(
      describeToolCall({ name: "readFiles", input: { paths: ["./src/a.ts", "../x", "src/"] } }, pathOf),
    ).toEqual(["src/a.ts", "src"]);
    expect(describeToolCall({ name: "updateFile", input: { path: "src/a.ts", content: "" } }, pathOf)).toEqual([
      "src/a.ts",
    ]);
    expect(
      describeToolCall({ name: "renameFile", input: { path: "src/a.ts", newName: "b.ts" } }, pathOf),
    ).toEqual(["src/a.ts", "b.ts"]);
    const written = describeToolCall(
      { name: "writeFiles", input: { files: [{ path: "src/ui/b.tsx" }, { path: "/abs" }] } },
      pathOf,
    );
    expect(written).toEqual(["src/ui/b.tsx"]);
    expect(runWrittenPaths([{ id: "w", kind: "tool", tool: "writeFiles", targets: written, status: "done", startedAt: 0 }])).toEqual([
      "src/ui/b.tsx",
    ]);
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
  const check = (id: string, status: AgentStep["status"], extra: Partial<AgentStep> = {}): AgentStep => ({
    id,
    kind: "tool",
    tool: "checkBuild",
    status,
    startedAt: 0,
    ...extra,
  });
  const failed = check("build-fail", "error", { error: "Error: Build failed. Fix these errors" });
  const staticFailed = check("static-fail", "error", { error: `${STATIC_CHECKS_FAILED}:\n- src/Hero.tsx is missing` });
  const verified = check("verified", "done", { text: BUILD_VERIFIED });
  const staticPassed = check("static-pass", "done", { text: STATIC_CHECKS_PASSED });

  it("counts failed checks a later verified build resolved", () => {
    expect(fixedBuildErrors([failed, verified])).toBe(1);
    expect(fixedBuildErrors([failed, failed, verified])).toBe(2);
  });

  it("leaves failures with no verified build after them unresolved", () => {
    expect(fixedBuildErrors([failed, failed])).toBe(0);
    expect(fixedBuildErrors([failed, verified, failed])).toBe(1);
    expect(fixedBuildErrors([failed, staticPassed])).toBe(0);
  });

  it("lets any passing check resolve a static-check failure, as the finish gate does", () => {
    const edit: AgentStep = { ...staticPassed, id: "edit", tool: "createFiles", text: undefined };
    expect(fixedBuildErrors([staticFailed, edit, staticPassed])).toBe(1);
    expect(fixedBuildErrors([staticFailed, check("not-checked", "done", { text: BUILD_NOT_CHECKED })])).toBe(1);
    expect(fixedBuildErrors([staticFailed, failed, staticPassed])).toBe(1);
  });

  it("ignores running checks, checks that could not finish and other tools", () => {
    const unfinished = check("unfinished", "error", { error: `${BUILD_CHECK_UNFINISHED} (timeout).` });
    const otherTool: AgentStep = { ...failed, id: "other", tool: "updateFile" };
    expect(fixedBuildErrors([check("running", "running"), unfinished, otherTool, verified])).toBe(0);
  });
});

describe("runWrittenPaths", () => {
  const step = (tool: string, targets: string[], status: AgentStep["status"] = "done"): AgentStep => ({
    id: `${tool}:${targets.join(",")}`,
    kind: "tool",
    tool,
    targets,
    status,
    startedAt: 0,
  });

  it("collects finished writes, with a rename's new path next to the old one", () => {
    expect(
      runWrittenPaths([
        step("readFiles", ["a.ts"]),
        step("createFiles", ["src/a.ts", "src/b.ts"]),
        step("updateFile", ["src/a.ts"]),
        step("renameFile", ["src/old.ts", "new.ts"]),
        step("renameFile", ["root.ts", "top.ts"]),
        step("deleteFiles", ["lib"]),
        step("updateFile", ["failed.ts"], "error"),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts", "src/old.ts", "src/new.ts", "root.ts", "top.ts", "lib"]);
  });

  it("keeps every path of a write over 20 files, so the diff is complete", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.ts`, content: "" }));
    const created = describeToolCall({ name: "createFiles", input: { parentId: ID_SRC, files } }, pathOf);
    expect(created).toHaveLength(25);
    expect(runWrittenPaths([step("createFiles", created)])).toHaveLength(25);
    // Reads stay capped; they only label the row.
    const ids = Array.from({ length: 25 }, () => ID_A);
    expect(describeToolCall({ name: "readFiles", input: { fileIds: ids } }, pathOf)).toHaveLength(20);
  });
});

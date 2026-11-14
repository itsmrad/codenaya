/**
 * A complete new-Vite-app build replayed through the real `processMessage`
 * with a scripted (stub) model and an in-memory files table (#292): scaffold,
 * one writeFiles call into new nested folders, checkBuild, summary. The agent
 * never calls createFolder or createFiles.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { _id: string; name: string; type: "file" | "folder"; parentId?: string; content?: string };

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), rows: [] as Row[] }));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

import { drive, text, toolCall } from "./process-message.driver";

const QUERIES: Record<string, (args: { fileId?: string }) => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectSkills": () => [],
  "system:getProjectFiles": () => mocks.rows.map((row) => ({ ...row, content: undefined })),
  "system:getProjectFilesWithUrls": () => mocks.rows,
  "system:getFileById": ({ fileId }) => mocks.rows.find((row) => row._id === fileId) ?? null,
};

const insert = (row: Omit<Row, "_id">) => {
  const _id = `id${mocks.rows.length}`;
  mocks.rows.push({ ...row, _id });
  return _id;
};

const MUTATIONS: Record<string, (args: Record<string, never>) => unknown> = {
  "system:createFolder": (args) => insert({ name: args.name, type: "folder", parentId: args.parentId }),
  "system:createFiles": (args) =>
    (args.files as { name: string; content: string }[]).map((file) => {
      const existing = mocks.rows.find(
        (row) => row.type === "file" && row.name === file.name && row.parentId === args.parentId,
      );
      return existing
        ? { name: file.name, fileId: existing._id, error: "File already exists" }
        : { name: file.name, fileId: insert({ ...file, type: "file", parentId: args.parentId }) };
    }),
  "system:updateFile": (args) => {
    mocks.rows.find((row) => row._id === args.fileId)!.content = args.content;
    return args.fileId;
  },
};

const pathOf = (row: Row): string => {
  const parent = mocks.rows.find((r) => r._id === row.parentId);
  return parent ? `${pathOf(parent)}/${row.name}` : row.name;
};

const recordedTools = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:upsertMessageSteps")
    .flatMap(([, args]) => (args as { steps: Array<{ kind: string; tool?: string }> }).steps)
    .filter((step) => step.kind === "tool")
    .map((step) => step.tool);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  // No sandbox: checkBuild runs its static checks only.
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.rows = [];
  mocks.query.mockImplementation(async (ref, args) => QUERIES[getFunctionName(ref)]?.(args));
  mocks.mutation.mockImplementation(async (ref, args) => MUTATIONS[getFunctionName(ref)]?.(args) ?? null);
});

describe("processMessage new Vite app build (#292)", () => {
  it("builds by path with no createFolder or createFiles calls", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: toolCall("scaffoldViteApp") },
      {
        data: toolCall("writeFiles", {
          files: [
            {
              path: "src/components/ui/button.tsx",
              content:
                'import { cn } from "@/lib/utils";\n\nexport function Button() {\n  return <button className={cn("px-4")}>Go</button>;\n}\n',
            },
            {
              path: "src/App.tsx",
              content:
                'import { Button } from "@/components/ui/button";\n\nexport default function App() {\n  return <Button />;\n}\n',
            },
          ],
        }),
      },
      { data: toolCall("checkBuild") },
      { data: text("**What was built:** a starter with a button.") },
    ], "Build a landing page");

    expect(outcome.finalType).toBe("function-resolved");
    expect(recordedTools()).toEqual(
      expect.arrayContaining(["scaffoldViteApp", "writeFiles", "checkBuild"]),
    );
    expect(recordedTools()).not.toContain("createFolder");
    expect(recordedTools()).not.toContain("createFiles");

    const files = mocks.rows.filter((row) => row.type === "file");
    expect(files.map(pathOf)).toContain("src/components/ui/button.tsx");
    expect(files.find((row) => pathOf(row) === "src/App.tsx")?.content).toContain("<Button />");
    // Each folder exists once.
    const folders = mocks.rows.filter((row) => row.type === "folder").map(pathOf);
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toEqual(expect.arrayContaining(["src", "src/components", "src/components/ui"]));

    // The static check passed, so the gate did not route the run back.
    expect(JSON.stringify(outcome.inferenceBodies.at(-1))).toContain("Static checks passed");
  });
});

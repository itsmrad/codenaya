import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import type { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";
import { createReadFilesTool } from "./read-files";
import { createUpdateFileTool } from "./update-file";
import { createCreateFilesTool } from "./create-files";
import { createRenameFileTool } from "./rename-file";
import { createDeleteFilesTool } from "./delete-files";

// Runs the step body inline, so a throw inside step.run propagates like it
// would to Inngest (which retries the step).
const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const internalKey = "key";
const projectId = "project_a" as Id<"projects">;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Routes the mocked Convex reads: `getProjectFiles` (the path index, #292)
 * gets `tree`, and each `getFileById` gets `lookup(fileId)`.
 */
const files = (lookup: (fileId: string) => unknown, tree: unknown[] = []) =>
  mocks.query.mockImplementation(async (ref, args: { fileId?: string }) =>
    getFunctionName(ref) === "system:getProjectFiles" ? tree : lookup(args.fileId ?? ""),
  );

// `system.getFileById` resolves a malformed ID to null (convex/system.test.ts),
// so the tools see it like any missing file.
describe("getFileByAgentId", () => {
  it("rethrows other errors so Inngest can retry them", async () => {
    mocks.query.mockRejectedValue(new Error("fetch failed"));
    await expect(getFileByAgentId(internalKey, projectId, "f1")).rejects.toThrow("fetch failed");
  });
});

describe("readFiles tool", () => {
  const read = (fileIds: string[]) =>
    createReadFilesTool({ projectId, internalKey }).handler({ fileIds }, ctx);

  it("returns a tool error for malformed IDs without throwing inside the step", async () => {
    files(() => null);
    expect(await read(["src/App.tsx"])).toBe(
      "Error: No files found. Use listFiles to see the project's paths.",
    );
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("skips malformed IDs and still reads valid ones", async () => {
    files((id) => (id === "f1" ? { _id: "f1", name: "App.tsx", content: "x" } : null));
    expect(JSON.parse((await read(["bad", "f1"])) as string)).toEqual([
      { id: "f1", path: "App.tsx", content: "x" },
    ]);
  });
});

describe("single-file tools", () => {
  it.each([
    ["updateFile", () => createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "bad", content: "x" }, ctx)],
    ["renameFile", () => createRenameFileTool({ projectId, internalKey }).handler({ fileId: "bad", newName: "a.ts" }, ctx)],
    ["deleteFiles", () => createDeleteFilesTool({ projectId, internalKey }).handler({ fileIds: ["bad"] }, ctx)],
  ])("%s returns a not-found tool error for a malformed ID", async (_name, call) => {
    files(() => null);
    expect(await call()).toBe(
      'Error: File with ID "bad" not found. Use listFiles to see the project\'s paths.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

// Convex returns null for a file from another project (#209), so the tools
// report it like any missing file and never reach a write.
describe("project scope", () => {
  it("looks files up in the run's project", async () => {
    mocks.query.mockResolvedValue(null);
    await getFileByAgentId(internalKey, projectId, "f1");
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), {
      internalKey,
      projectId,
      fileId: "f1",
    });
  });

  it.each([
    ["updateFile", () => createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "foreign", content: "x" }, ctx)],
    ["renameFile", () => createRenameFileTool({ projectId, internalKey }).handler({ fileId: "foreign", newName: "a.ts" }, ctx)],
    ["deleteFiles", () => createDeleteFilesTool({ projectId, internalKey }).handler({ fileIds: ["foreign"] }, ctx)],
  ])("%s returns a tool error for a foreign file and writes nothing", async (_name, call) => {
    files(() => null);
    expect(await call()).toBe(
      'Error: File with ID "foreign" not found. Use listFiles to see the project\'s paths.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  // #219: the id would be shown to the user as "a file".
  it("names the folder, not its id, when asked to update a folder", async () => {
    files(() => ({ _id: "d1", name: "ui", type: "folder" }));
    expect(
      await createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "d1", content: "x" }, ctx),
    ).toBe('Error: "ui" is a folder, not a file. You can only update file contents.');
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("passes the run's projectId to the write", async () => {
    files(() => ({ _id: "f1", name: "App.tsx", type: "file" }));
    await createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "f1", content: "x" }, ctx);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey,
      projectId,
      fileId: "f1",
      content: "x",
    });
  });
});

// #331: an unpinned package resolves to today's newest major, which the starter may not run.
describe("package.json version pins", () => {
  const latestRouter = JSON.stringify({ dependencies: { "react-router-dom": "latest" } });
  const savedRouterRange = () =>
    JSON.parse(mocks.mutation.mock.calls[0][1].content ?? mocks.mutation.mock.calls[0][1].files[0].content)
      .dependencies["react-router-dom"];

  it("updateFile saves the known-good range and says so", async () => {
    mocks.query.mockResolvedValue({ _id: "f1", name: "package.json", type: "file" });
    const result = await createUpdateFileTool({ projectId, internalKey }).handler(
      { fileId: "f1", content: latestRouter },
      ctx,
    );
    expect(savedRouterRange()).toMatch(/^\^7\./);
    expect(result).toContain('react-router-dom "latest" →');
  });

  it("createFiles saves the known-good range and says so", async () => {
    mocks.mutation.mockResolvedValue([{ name: "package.json" }]);
    const result = await createCreateFilesTool({ projectId, internalKey }).handler(
      { parentId: "", files: [{ name: "package.json", content: latestRouter }] },
      ctx,
    );
    expect(savedRouterRange()).toMatch(/^\^7\./);
    expect(result).toContain('react-router-dom "latest" →');
  });
});

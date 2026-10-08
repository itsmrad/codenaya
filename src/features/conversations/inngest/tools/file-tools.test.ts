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
import { createRenameFileTool } from "./rename-file";
import { createDeleteFilesTool } from "./delete-files";

// The error Convex returns when an arg fails `v.id("files")`.
const invalidIdError = () =>
  new Error(
    '[Request ID: x] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .fileId\nValue: "src/App.tsx"\nValidator: v.id("files")',
  );

// Runs the step body inline, so a throw inside step.run propagates like it
// would to Inngest (which retries the step).
const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;
const internalKey = "key";
const projectId = "project_a" as Id<"projects">;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFileByAgentId", () => {
  it("resolves a malformed ID to null instead of throwing", async () => {
    mocks.query.mockRejectedValue(invalidIdError());
    await expect(getFileByAgentId(internalKey, projectId, "src/App.tsx")).resolves.toBeNull();
  });

  it("rethrows other errors so Inngest can retry them", async () => {
    mocks.query.mockRejectedValue(new Error("fetch failed"));
    await expect(getFileByAgentId(internalKey, projectId, "f1")).rejects.toThrow("fetch failed");
  });
});

describe("readFiles tool", () => {
  const read = (fileIds: string[]) =>
    createReadFilesTool({ projectId, internalKey }).handler({ fileIds }, ctx);

  it("returns a tool error for malformed IDs without throwing inside the step", async () => {
    mocks.query.mockRejectedValue(invalidIdError());
    expect(await read(["src/App.tsx"])).toBe(
      "Error: No files found with provided IDs. Use listFiles to get valid fileIDs.",
    );
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("skips malformed IDs and still reads valid ones", async () => {
    mocks.query
      .mockRejectedValueOnce(invalidIdError())
      .mockResolvedValueOnce({ _id: "f1", name: "App.tsx", content: "x" });
    expect(JSON.parse((await read(["bad", "f1"])) as string)).toEqual([
      { id: "f1", name: "App.tsx", content: "x" },
    ]);
  });
});

describe("single-file tools", () => {
  it.each([
    ["updateFile", () => createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "bad", content: "x" }, ctx)],
    ["renameFile", () => createRenameFileTool({ projectId, internalKey }).handler({ fileId: "bad", newName: "a.ts" }, ctx)],
    ["deleteFiles", () => createDeleteFilesTool({ projectId, internalKey }).handler({ fileIds: ["bad"] }, ctx)],
  ])("%s returns a not-found tool error for a malformed ID", async (_name, call) => {
    mocks.query.mockRejectedValue(invalidIdError());
    expect(await call()).toBe(
      'Error: File with ID "bad" not found. Use listFiles to get valid file IDs.',
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
    mocks.query.mockResolvedValue(null);
    expect(await call()).toBe(
      'Error: File with ID "foreign" not found. Use listFiles to get valid file IDs.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("passes the run's projectId to the write", async () => {
    mocks.query.mockResolvedValue({ _id: "f1", name: "App.tsx", type: "file" });
    await createUpdateFileTool({ projectId, internalKey }).handler({ fileId: "f1", content: "x" }, ctx);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey,
      projectId,
      fileId: "f1",
      content: "x",
    });
  });
});

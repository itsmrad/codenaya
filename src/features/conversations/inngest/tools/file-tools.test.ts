import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFileByAgentId", () => {
  it("resolves a malformed ID to null instead of throwing", async () => {
    mocks.query.mockRejectedValue(invalidIdError());
    await expect(getFileByAgentId(internalKey, "src/App.tsx")).resolves.toBeNull();
  });

  it("rethrows other errors so Inngest can retry them", async () => {
    mocks.query.mockRejectedValue(new Error("fetch failed"));
    await expect(getFileByAgentId(internalKey, "f1")).rejects.toThrow("fetch failed");
  });
});

describe("readFiles tool", () => {
  const read = (fileIds: string[]) =>
    createReadFilesTool({ internalKey }).handler({ fileIds }, ctx);

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
    ["updateFile", () => createUpdateFileTool({ internalKey }).handler({ fileId: "bad", content: "x" }, ctx)],
    ["renameFile", () => createRenameFileTool({ internalKey }).handler({ fileId: "bad", newName: "a.ts" }, ctx)],
    ["deleteFiles", () => createDeleteFilesTool({ internalKey }).handler({ fileIds: ["bad"] }, ctx)],
  ])("%s returns a not-found tool error for a malformed ID", async (_name, call) => {
    mocks.query.mockRejectedValue(invalidIdError());
    expect(await call()).toBe(
      'Error: File with ID "bad" not found. Use listFiles to get valid file IDs.',
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

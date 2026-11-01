import { beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
import { createSearchFilesTool } from "./search-files";
import type { Id } from "../../../../../convex/_generated/dataModel";

const options = { projectId: "project" as Id<"projects">, internalKey: "test-key" };
const step = { run: vi.fn(async (_name: string, fn: () => unknown) => fn()) };
beforeEach(() => vi.clearAllMocks());
it("searches inside a replayable step with the run's project and returns query output", async () => {
  mocks.query.mockResolvedValue("src/app.ts:1: hello");
  expect(await createSearchFilesTool(options).handler({ pattern: "hello" }, { step } as never)).toBe("src/app.ts:1: hello");
  expect(step.run).toHaveBeenCalledWith("search-files", expect.any(Function));
  const [ref, args] = mocks.query.mock.calls[0];
  expect(getFunctionName(ref)).toBe("files:searchFiles");
  expect(args).toEqual({ ...options, pattern: "hello" });
});
it("rejects invalid tool input before querying", async () => {
  expect(await createSearchFilesTool(options).handler({ pattern: "", maxResults: -1 }, { step } as never)).toMatch(/^Error:/);
  expect(mocks.query).not.toHaveBeenCalled();
});

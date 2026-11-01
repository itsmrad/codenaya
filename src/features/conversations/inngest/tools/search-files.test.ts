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

it("resolves query failures inside the step so Inngest does not retry an expensive search", async () => {
  mocks.query.mockRejectedValue(new Error("query execution timed out"));
  const error = "Error: search too expensive; narrow pathGlob or use a literal pattern";
  expect(await createSearchFilesTool(options).handler({ pattern: "x", isRegex: true }, { step } as never)).toBe(error);
  await expect(step.run.mock.results[0].value).resolves.toBe(error);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});

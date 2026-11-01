import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
import { createSearchFilesTool } from "./search-files";
import type { Id } from "../../../../../convex/_generated/dataModel";

const options = { projectId: "project" as Id<"projects">, internalKey: "test-key" };
const step = { run: vi.fn(async (_name: string, fn: () => unknown) => fn()) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
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

it.each([
  "Function execution timed out (maximum duration: 1s)",
  "Your request timed out performing too many system operations.",
  "Too many bytes read in a single function execution (limit: 16777216 bytes).",
  "Too many documents read in a single function execution (limit: 32000).",
  "Too many reads in a single function execution (limit: 4096).",
  "TooManyBytesRead",
  "TooManyDocumentsRead",
  "TooManyReads",
])("resolves Convex execution/read limits inside the step: %s", async (message) => {
  mocks.query.mockRejectedValue(new Error(message));
  const error = "Error: search too expensive; narrow pathGlob or use a literal pattern";
  expect(await createSearchFilesTool(options).handler({ pattern: "x", isRegex: true }, { step } as never)).toBe(error);
  await expect(step.run.mock.results[0].value).resolves.toBe(error);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith("[searchFiles] query failed", message);
});

it.each([
  "Invalid internal key",
  "CODENAYA_CONVEX_INTERNAL_KEY is not configured",
  "ArgumentValidationError: Object is missing the required field",
  "fetch failed",
  "HTTP 503 Service Unavailable",
  "request timed out",
])("logs and rethrows other failures: %s", async (message) => {
  const error = new Error(message);
  mocks.query.mockRejectedValue(error);
  await expect(createSearchFilesTool(options).handler({ pattern: "x" }, { step } as never)).rejects.toBe(error);
  expect(console.error).toHaveBeenCalledWith("[searchFiles] query failed", message);
});

it("redacts the internal key from logged validation errors", async () => {
  const error = new Error(`ArgumentValidationError: internalKey: ${options.internalKey}`);
  mocks.query.mockRejectedValue(error);
  await expect(createSearchFilesTool(options).handler({ pattern: "x" }, { step } as never)).rejects.toBe(error);
  expect(console.error).toHaveBeenCalledWith("[searchFiles] query failed", "ArgumentValidationError: internalKey: [redacted]");
});

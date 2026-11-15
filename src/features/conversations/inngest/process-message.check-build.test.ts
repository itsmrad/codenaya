/**
 * The build-check finish gate in a real `processMessage` run: a run that
 * writes files and ends without a passing checkBuild is routed back with a
 * note, a bounded number of times, and the check's result reaches the model
 * and the run block. A run that still fails says so and is not a success.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: mocks.createSandbox },
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

import {
  BUILD_CHECK_NUDGE,
  BUILD_FAILED_NOTE,
  BUILD_NOT_BUILT_NOTE,
  BUILD_REPAIR_NUDGE,
  BUILD_RETRY_NUDGE,
  BUILD_UNVERIFIED_NOTE,
} from "./build-check-gate";
import { drive, text, toolCall } from "./process-message.driver";

let projectFiles: Array<{ _id: string; name: string; type: "file"; content: string }>;

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => projectFiles,
  "system:getProjectFilesWithUrls": () => projectFiles,
  "system:getEnvVarsForSandbox": () => [],
  "system:getProjectSkills": () => [],
};

// The project's files change when the call runs, through the createFiles mock.
const writeMain = (content: string) =>
  toolCall("createFiles", { parentId: "", files: [{ name: "main.ts", content }] });

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const VITE_FILES = [
  { _id: "v1", name: "package.json", type: "file" as const, content: "{}" },
  { _id: "v2", name: "vite.config.ts", type: "file" as const, content: "export default {};\n" },
  { _id: "v3", name: "tsconfig.app.json", type: "file" as const, content: "{}" },
];

const fakeSandbox = (run: unknown) => ({
  files: { makeDir: vi.fn(async () => true), write: vi.fn(async () => ({})) },
  commands: { run },
  kill: vi.fn(async () => {}),
});

const BROKEN = 'import { start } from "./missing";\nstart();\n';

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

/** Every step the run recorded for the run block, last write wins. */
const recordedSteps = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:upsertMessageSteps")
    .flatMap(([, args]) => (args as { steps: Array<Record<string, unknown>> }).steps);

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  // No sandbox: checkBuild runs its static checks only.
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  projectFiles = [];
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== "system:createFiles") return null;
    const { files } = args as { files: Array<{ name: string; content: string }> };
    const written = new Set(files.map(({ name }) => name));
    projectFiles = [
      ...projectFiles.filter(({ name }) => !written.has(name)),
      ...files.map(({ name, content }) => ({ _id: "f1", name, type: "file" as const, content })),
    ];
    return files.map(({ name }) => ({ name, fileId: "f1" }));
  });
});

describe("processMessage build-check gate", () => {
  it("routes a run that wrote files back, and the check's errors reach the model", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain(BROKEN) },
      { data: text("**What was built:** a starter.") },
      { data: toolCall("checkBuild") },
      { data: text("**Notes:** main.ts imports ./missing, which does not exist.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests[0].tools?.map((tool) => tool.function.name)).toContain("checkBuild");

    // Only the forced turn carries the note.
    expect(requests[2].messages.at(-1)).toEqual({ role: "user", content: BUILD_CHECK_NUDGE });
    expect(JSON.stringify(requests[1].messages)).not.toContain(BUILD_CHECK_NUDGE);
    expect(JSON.stringify(requests[3].messages)).not.toContain(BUILD_CHECK_NUDGE);

    const checkResult = JSON.stringify(requests[3].messages);
    expect(checkResult).toContain("Static checks failed");
    expect(checkResult).toContain("./missing (imported by main.ts)");

    const check = recordedSteps().filter((step) => step.tool === "checkBuild").at(-1);
    expect(check).toMatchObject({ status: "error" });
    expect(String(check?.error)).toContain("Static checks failed");

    // The forced check turn is not a repair: the first fix turn is attempt 1.
    const repairs = recordedSteps().filter((step) => String(step.id).startsWith("build-repair-"));
    expect(repairs.map((step) => [step.id, step.text])).toEqual([
      ["build-repair-1", expect.stringContaining("(attempt 1)")],
      ["build-repair-2", expect.stringContaining("(attempt 2)")],
    ]);
  });

  it("does not end on a failed check: the fix turn repairs it and the run finishes verified", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    projectFiles = VITE_FILES.map((file) => ({ ...file }));
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    mocks.createSandbox.mockResolvedValue(fakeSandbox(run));
    // This run ends a seeded project's first build (#341).
    const base = mocks.mutation.getMockImplementation()!;
    mocks.mutation.mockImplementation(async (ref, args) =>
      getFunctionName(ref) === "projects:completeFirstBuild" ? true : base(ref, args),
    );
    const summary = "**What was built:** a script.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain(BROKEN) },
      { data: toolCall("checkBuild") },
      // The run used to end here, broken, as a success.
      { data: text("**Notes:** main.ts imports ./missing.") },
      { data: writeMain("console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(6);
    expect(requests[3].messages.at(-1)).toEqual({ role: "user", content: BUILD_REPAIR_NUDGE });
    expect(JSON.stringify(requests[4].messages)).not.toContain(BUILD_REPAIR_NUDGE);

    // The static failure stops before the sandbox; the fixed tree installs and builds.
    expect(run).toHaveBeenCalledTimes(2);
    expect(recordedSteps().filter((step) => step.tool === "checkBuild").at(-1)).toMatchObject({
      status: "done",
      text: "Build verified",
    });
    expect(recordedSteps().find((step) => step.id === "build-repair-1")).toMatchObject({
      kind: "thinking",
      text: expect.stringContaining("(attempt 1)"),
    });
    const update = mutationArgs("system:updateMessageContent").at(-1);
    expect(update).toMatchObject({ content: summary });
    expect(update).not.toHaveProperty("outcome");
    expect(mutationArgs("projects:completeFirstBuild")).toHaveLength(1);
    expect(update).toMatchObject({ firstBuild: true });
  });

  it.each([
    ["finishes verified when the retry builds", false],
    ["ends unverified, with no third check, when the retry cannot finish either", true],
  ])("retries a check that could not finish once: %s", async (_, retryTimesOut) => {
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    projectFiles = VITE_FILES.map((file) => ({ ...file }));
    // The install times out, as when the preview is still installing new packages.
    const timeout = new Error("deadline_exceeded");
    const run = vi.fn().mockRejectedValueOnce(timeout);
    if (retryTimesOut) run.mockRejectedValueOnce(timeout);
    run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.createSandbox.mockResolvedValue(fakeSandbox(run));
    const summary = "**What was built:** a script.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain("console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text("**Notes:** The build was not verified.") },
      { data: toolCall("checkBuild") },
      // Repeated by the driver if the gate asked for more.
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(5);
    expect(requests[3].messages.at(-1)).toEqual({ role: "user", content: BUILD_RETRY_NUDGE });
    expect(run).toHaveBeenCalledTimes(retryTimesOut ? 2 : 3);
    const update = mutationArgs("system:updateMessageContent").at(-1);
    if (retryTimesOut) {
      expect(update).toMatchObject({ content: `${summary}\n\n${BUILD_UNVERIFIED_NOTE}`, outcome: "error" });
    } else {
      expect(update).toMatchObject({ content: summary });
      expect(update).not.toHaveProperty("outcome");
    }
  });

  it("stops after the check budget and says the build still fails, as an error", async () => {
    const notes = "**Notes:** main.ts still has a missing import.";
    // A different error each time, so the loop guard does not end the run first.
    const broken = (name: string) => writeMain(`import { start } from "./${name}";\nstart();\n`);
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: broken("lost") },
      { data: toolCall("checkBuild") },
      { data: text(notes) },
      { data: broken("gone") },
      { data: toolCall("checkBuild") },
      { data: text(notes) },
      { data: broken("absent") },
      { data: toolCall("checkBuild") },
      // Repeated by the driver if the gate asked for more.
      { data: text(notes) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(9);
    expect(requests.filter((request) => request.messages.at(-1)?.content === BUILD_REPAIR_NUDGE)).toHaveLength(2);

    const repairs = recordedSteps().filter((step) => String(step.id).startsWith("build-repair-"));
    expect(repairs.map((step) => step.id)).toEqual(["build-repair-1", "build-repair-2"]);
    const update = mutationArgs("system:updateMessageContent").at(-1);
    expect(update).toMatchObject({ content: `${notes}\n\n${BUILD_FAILED_NOTE}`, outcome: "error" });
    expect(update).not.toHaveProperty("stuck");
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
  });

  it("ends without an extra turn when the agent checked after its last write, but not as verified without a build", async () => {
    const summary = "**What was built:** a script.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain("console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text(summary) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(3);
    // A passing check records what it verified as the row's label.
    expect(recordedSteps().filter((step) => step.tool === "checkBuild").at(-1)).toMatchObject({
      status: "done",
      text: "Build not checked",
    });
    // Not a Vite project, so nothing was built: the reply says so.
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({
      content: `${summary}\n\n${BUILD_NOT_BUILT_NOTE}`,
      outcome: "error",
    });
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
  });

  it("does not count static checks alone as verified when no sandbox is configured", async () => {
    projectFiles = VITE_FILES.map((file) => ({ ...file }));
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain("console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text("**What was built:** a script.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(3);
    expect(recordedSteps().filter((step) => step.tool === "checkBuild").at(-1)).toMatchObject({
      status: "done",
      text: "Static checks passed",
    });
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({ outcome: "error" });
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
  });

  it("sends the known cause and fix with a matched build error and records the recipe on the step", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    projectFiles = [
      { _id: "f1", name: "package.json", type: "file", content: "{}" },
      { _id: "f2", name: "vite.config.ts", type: "file", content: "export default {};\n" },
      { _id: "f3", name: "tsconfig.app.json", type: "file", content: "{}" },
    ];
    const { CommandExitError } = await import("e2b");
    // tsc runs before the Vite build, so it reports a bad import first.
    const build = {
      exitCode: 2,
      error: "",
      stdout:
        "/home/user/app/src/App.tsx(1,21): error TS2307: Cannot find module './missing' or its corresponding type declarations.\n",
      stderr: "",
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new CommandExitError(build));
    mocks.createSandbox.mockResolvedValue(fakeSandbox(run));

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: toolCall("checkBuild") },
      { data: text("**Notes:** the build fails on ./missing.") },
    ]);

    expect(run.mock.calls[1][0]).toMatch(/^npx tsc --noEmit -p tsconfig\.app\.json && npx vite build$/);
    const checkResult = JSON.stringify(codingRequests(outcome.inferenceBodies)[1].messages);
    expect(checkResult).toContain("Likely cause (unresolved-import): ");
    expect(checkResult).toContain("Known fix: ");
    expect(recordedSteps().filter((step) => step.tool === "checkBuild").at(-1)).toMatchObject({
      status: "error",
      recipeIds: ["unresolved-import"],
    });
  });

  it("does not offer checkBuild in plan mode", async () => {
    const outcome = await drive(
      { modelId: "x-ai/grok-4.7" },
      [{ data: text("## Plan\n1. Do it") }],
      "Plan a todo app",
      { mode: "plan" },
    );

    const [first] = codingRequests(outcome.inferenceBodies);
    expect(first.tools?.map((tool) => tool.function.name)).not.toContain("checkBuild");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(1);
  });
});

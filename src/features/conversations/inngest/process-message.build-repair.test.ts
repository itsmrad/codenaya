/**
 * The repair after the run in a real `processMessage` run: changes that end
 * on a failed check (or none) are checked and repaired in a new sandbox
 * before the run completes, metered like the run's own inferences.
 */

import { getFunctionName } from "convex/server";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  createSandbox: vi.fn(),
  connectSandbox: vi.fn(),
  killSandbox: vi.fn(),
  listSandboxes: vi.fn(),
  verifyAndFix: vi.fn(),
}));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: {
    create: mocks.createSandbox,
    connect: mocks.connectSandbox,
    kill: mocks.killSandbox,
    list: mocks.listSandboxes,
  },
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

vi.mock("@/features/conversations/server/sandbox-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/sandbox-repair")>()),
  verifyAndFix: mocks.verifyAndFix,
}));

import type { RepairEvent, RepairResult, VerifyAndFixOptions } from "../server/sandbox-repair";
import { DEFAULT_INSTALL_COMMAND, WORK_DIR } from "@/features/sandbox-preview/server/project-sandbox";
import { BUILD_FAILED_NOTE, BUILD_REPAIRED_NOTE, BUILD_UNVERIFIED_NOTE } from "./build-check-gate";
import { MAX_SERVER_REPAIRS } from "./build-repair";
import { drive, text, toolCall } from "./process-message.driver";
import { stopRepairSandboxes } from "./stop-repair-sandboxes";

type Row = { _id: string; name: string; type: "file"; content: string };
let projectFiles: Row[];

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

const VITE_FILES: Row[] = [
  { _id: "v1", name: "package.json", type: "file", content: "{}" },
  { _id: "v2", name: "vite.config.ts", type: "file", content: "export default {};\n" },
  { _id: "v3", name: "tsconfig.app.json", type: "file", content: "{}" },
];

const write = (name: string, content = "export const x = 1;\n") =>
  toolCall("createFiles", { parentId: "", files: [{ name, content }] });
const NOTES = "**Notes:** main.ts still has a missing import.";
const SUMMARY = "**What was built:** a script.";

/** Ends on a failed check: each fix turn's static check fails on a new missing import. */
const FAILED_RUN = [
  ...["lost", "gone", "absent"].flatMap((name) => [
    { data: write("main.ts", `import { start } from "./${name}";\nstart();\n`) },
    { data: toolCall("checkBuild") },
    { data: text(NOTES) },
  ]),
];

/** Ends with no check after its writes: every forced check turn writes instead. */
const UNCHECKED_RUN = ["a.ts", "b.ts", "c.ts", "d.ts"].flatMap((name) => [
  { data: write(name) },
  { data: text(SUMMARY) },
]);

const mutationArgs = (name: string) =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);

const recordedSteps = () =>
  mutationArgs("system:upsertMessageSteps").flatMap(
    (args) => (args as { steps: Array<Record<string, unknown>> }).steps,
  );

/** The sandbox the repair provisions: files written to it are kept, by absolute path. */
const fakeSandbox = (run: Mock = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))) => {
  const fs = new Map<string, string>();
  return {
    fs,
    sandboxId: "sbx_repair",
    files: {
      makeDir: vi.fn(async () => true),
      write: vi.fn(async (entries: Array<{ path: string; data: string }>) => {
        for (const { path, data } of entries) fs.set(path, data);
      }),
      read: vi.fn(async (path: string) => new TextEncoder().encode(fs.get(path) ?? "")),
    },
    commands: { run },
    kill: vi.fn(async () => {}),
  };
};

/** A verifyAndFix that reports one failed check, a repair (with its model usage) and `result`. */
const scriptedRepair = (result: RepairResult) => async (options: VerifyAndFixOptions) => {
  const event = (e: Omit<RepairEvent, "id">) => options.onEvent?.({ id: `${options.runId}:main:${e.phase}:${e.attempt}`, ...e });
  await event({ phase: "verify", attempt: 1, status: "error", errors: [{ file: "main.ts", line: 1, message: "error TS2307: Cannot find module './absent'", kind: "type" }] });
  await event({ phase: "repair", attempt: 1, status: "running" });
  await options.onResponse?.(JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 50 } }));
  await event({ phase: "repair", attempt: 1, status: "done", filesChanged: result.filesChanged });
  await event({ phase: "verify", attempt: 2, status: result.ok ? "done" : "error", errors: result.errors });
  return result;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "e2b_key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  projectFiles = VITE_FILES.map((file) => ({ ...file }));
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== "system:createFiles") return null;
    const { files } = args as { files: Array<{ name: string; content: string }> };
    const written = new Set(files.map(({ name }) => name));
    projectFiles = [
      ...projectFiles.filter(({ name }) => !written.has(name)),
      ...files.map(({ name, content }) => ({ _id: `f_${name}`, name, type: "file" as const, content })),
    ];
    return files.map(({ name }) => ({ name, fileId: `f_${name}` }));
  });
  const sandbox = fakeSandbox();
  mocks.createSandbox.mockResolvedValue(sandbox);
  mocks.connectSandbox.mockResolvedValue(sandbox);
  mocks.killSandbox.mockResolvedValue(true);
  // The repair sandbox, found by its run's metadata.
  mocks.listSandboxes.mockReturnValue({ nextItems: async () => [{ sandboxId: "sbx_repair" }] });
});

describe("processMessage repair after the run", () => {
  it("repairs a run that ended on a failed check with the run's model, metered, and ends verified", async () => {
    mocks.verifyAndFix.mockImplementation(
      scriptedRepair({ ok: true, status: "verified", errors: [], filesChanged: ["main.ts"], attempts: 1 }),
    );

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, FAILED_RUN);

    expect(outcome.finalType).toBe("function-resolved");
    const [options] = mocks.verifyAndFix.mock.calls.at(-1) as [VerifyAndFixOptions];
    expect(options).toMatchObject({
      projectId: "p1",
      internalKey: "ik",
      runId: "run-under-test",
      maxAttempts: MAX_SERVER_REPAIRS,
      model: { options: { model: "x-ai/grok-4.7" } },
    });

    // A new sandbox with the project, its npm cache warmed, then stopped.
    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ apiKey: "e2b_key", metadata: { projectId: "p1", runId: "run-under-test", purpose: "build-repair" } }),
    );
    const sandbox = await mocks.createSandbox.mock.results[0].value;
    expect([...sandbox.fs.keys()]).toContain(`${WORK_DIR}/main.ts`);
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      DEFAULT_INSTALL_COMMAND,
      expect.objectContaining({ cwd: WORK_DIR, timeoutMs: 240_000 }),
    );
    expect(mocks.listSandboxes).toHaveBeenCalledWith({
      apiKey: "e2b_key",
      query: { metadata: { purpose: "build-repair", runId: "run-under-test" }, state: ["running"] },
    });
    expect(mocks.killSandbox).toHaveBeenCalledWith("sbx_repair", { apiKey: "e2b_key" });

    // The repair's model usage goes through the run's own records.
    expect(mutationArgs("credits:recordRunUsage").at(-1)).toMatchObject({
      source: "platform",
      inputTokens: 500,
      outputTokens: 50,
    });

    // The trail: checks as checkBuild rows, the repair's note and its writes.
    const steps = recordedSteps();
    expect(steps.filter((step) => String(step.id).startsWith("run-under-test:main:"))).toEqual([
      expect.objectContaining({ tool: "checkBuild", status: "error", error: expect.stringContaining("main.ts: error TS2307") }),
      expect.objectContaining({ kind: "thinking", text: expect.stringContaining("(attempt 1)") }),
      expect.objectContaining({ tool: "editFile", targets: ["main.ts"], status: "done" }),
      expect.objectContaining({ tool: "checkBuild", status: "done", text: "Build verified" }),
    ]);

    const update = mutationArgs("system:updateMessageContent").at(-1);
    expect(update).toMatchObject({ content: `${NOTES}\n\n${BUILD_REPAIRED_NOTE}` });
    expect(update).not.toHaveProperty("outcome");
    expect(mutationArgs("projects:completeFirstBuild")).toHaveLength(1);
  });

  it("keeps the failed note and the error outcome when the repair does not fix it", async () => {
    mocks.verifyAndFix.mockImplementation(
      scriptedRepair({
        ok: false,
        status: "failed",
        errors: [{ message: "still broken", kind: "build" }],
        filesChanged: ["main.ts"],
        attempts: 2,
        reason: "Build still fails after 2 repair attempt(s)",
      }),
    );

    await drive({ modelId: "x-ai/grok-4.7" }, FAILED_RUN);

    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({
      content: `${NOTES}\n\n${BUILD_FAILED_NOTE}`,
      outcome: "error",
    });
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
    expect(mocks.killSandbox).toHaveBeenCalled();
  });

  it("does not repair when the first check cannot finish, and keeps the unverified note", async () => {
    const actual = await vi.importActual<typeof import("../server/sandbox-repair")>("../server/sandbox-repair");
    mocks.verifyAndFix.mockImplementation(actual.verifyAndFix);
    const sandbox = fakeSandbox(
      vi.fn(async (command: string, { cwd }: { cwd?: string } = {}) => {
        if (command.startsWith("find")) {
          const listing = [...sandbox.fs]
            .filter(([path]) => path.startsWith(`${cwd}/`))
            .map(([path, content]) => `${content.length} ${path.slice(`${cwd}/`.length)}`);
          return { exitCode: 0, stdout: listing.join("\n"), stderr: "" };
        }
        // Too many new packages: the install outlasts its budget every time.
        if (command.startsWith("npm install")) throw new Error("deadline_exceeded");
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    );
    mocks.createSandbox.mockResolvedValue(sandbox);
    mocks.connectSandbox.mockResolvedValue(sandbox);

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, UNCHECKED_RUN);

    expect(outcome.finalType).toBe("function-resolved");
    // The run's 8 turns and no repair turn.
    expect(outcome.inferenceBodies).toHaveLength(UNCHECKED_RUN.length);
    const checks = recordedSteps().filter((step) => String(step.id).startsWith("run-under-test:main:verify"));
    expect(checks.at(-1)).toMatchObject({ status: "error", error: expect.stringContaining("could not finish") });
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({
      content: `${SUMMARY}\n\n${BUILD_UNVERIFIED_NOTE}`,
      outcome: "error",
    });
    expect(mutationArgs("projects:completeFirstBuild")).toEqual([]);
    expect(mocks.killSandbox).toHaveBeenCalledWith("sbx_repair", { apiKey: "e2b_key" });
  });

  it.each([
    ["a verified run", () => vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), VITE_FILES],
    ["a run whose check could not finish", () => vi.fn(async () => Promise.reject(new Error("deadline_exceeded"))), VITE_FILES],
    ["a project the check cannot build", () => vi.fn(), [] as Row[]],
  ])("does not repair %s", async (_, run, files) => {
    projectFiles = files.map((file) => ({ ...file }));
    mocks.createSandbox.mockResolvedValue(fakeSandbox(run()));

    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: write("main.ts", "console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text(SUMMARY) },
      // A retry turn, for the check that could not finish.
      { data: toolCall("checkBuild") },
      { data: text(SUMMARY) },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
    expect(mutationArgs("system:updateMessageContent")).toHaveLength(1);
  });

  it("does not start a sandbox for a project the check cannot build, even after a failed check", async () => {
    projectFiles = [];

    await drive({ modelId: "x-ai/grok-4.7" }, FAILED_RUN);

    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
    expect(mutationArgs("system:updateMessageContent").at(-1)).toMatchObject({
      content: `${NOTES}\n\n${BUILD_FAILED_NOTE}`,
      outcome: "error",
    });
  });

  it("stops a failed or cancelled run's repair sandboxes, every one its run started", async () => {
    mocks.listSandboxes.mockReturnValue({
      nextItems: async () => [{ sandboxId: "sbx_first_try" }, { sandboxId: "sbx_retry" }],
    });

    const outcome = await drive({}, [], "", { function_id: "codenaya-process-message", run_id: "run_7" }, {
      fn: stopRepairSandboxes,
      eventName: "inngest/function.cancelled",
    });

    expect(outcome.finalType).toBe("function-resolved");
    expect(mocks.listSandboxes).toHaveBeenCalledWith({
      apiKey: "e2b_key",
      query: { metadata: { purpose: "build-repair", runId: "run_7" }, state: ["running"] },
    });
    expect(mocks.killSandbox.mock.calls.map(([id]) => id)).toEqual(["sbx_first_try", "sbx_retry"]);
  });

  it("looks for no sandbox without an E2B key", async () => {
    vi.stubEnv("E2B_API_KEY", "");

    await drive({}, [], "", { run_id: "run_7" }, {
      fn: stopRepairSandboxes,
      eventName: "inngest/function.failed",
    });

    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });

  it("stops a cancelled run before the repair", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, FAILED_RUN, "Build it", {}, {
      cancelWhen: () => mocks.createSandbox.mock.calls.length > 0,
    });

    expect(outcome.finalType).toBe("cancelled");
    expect(mocks.verifyAndFix).not.toHaveBeenCalled();
    expect(mutationArgs("system:updateMessageContent")).toEqual([]);
  });
});

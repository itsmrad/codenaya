/**
 * The build-check finish gate in a real `processMessage` run: a run that
 * writes files and ends without checkBuild is routed back once with a note,
 * and the check's result reaches the model and the run block.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));

import { BUILD_CHECK_NUDGE } from "./build-check-gate";
import { drive, text } from "./process-message.driver";

let projectFiles: Array<{ _id: string; name: string; type: "file"; content: string }>;

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => projectFiles,
  "system:getProjectSkills": () => [],
};

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
});

const writeMain = (content: string) => {
  projectFiles = [{ _id: "f1", name: "main.ts", type: "file", content }];
  return toolCall("createFiles", { parentId: "", files: [{ name: "main.ts", content }] });
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

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
  mocks.mutation.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === "system:createFiles"
      ? (args as { files: Array<{ name: string }> }).files.map(({ name }) => ({ name, fileId: "f1" }))
      : null,
  );
});

describe("processMessage build-check gate", () => {
  it("routes a run that wrote files back once, and the check's errors reach the model", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain('import { start } from "./missing";\nstart();\n') },
      { data: text("**What was built:** a starter.") },
      { data: toolCall("checkBuild") },
      { data: text("**Notes:** main.ts imports ./missing, which does not exist.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(4);
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
  });

  it("ends without an extra turn when the agent checked after its last write", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: writeMain("console.log(1);\n") },
      { data: toolCall("checkBuild") },
      { data: text("**What was built:** a script.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(codingRequests(outcome.inferenceBodies)).toHaveLength(3);
    // A passing check records what it verified as the row's label.
    expect(recordedSteps().filter((step) => step.tool === "checkBuild").at(-1)).toMatchObject({
      status: "done",
      text: "Build not checked",
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

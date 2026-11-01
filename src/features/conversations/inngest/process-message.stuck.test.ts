/**
 * Loop detection in a real `processMessage` run (#306): a run that keeps
 * rewriting one file that doesn't parse stops early with a no-tools
 * explanation turn, and the message is marked stuck for the hand-off card.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query), mutation: mocks.mutation } };
});

import { MAX_SAME_SYNTAX_ERROR } from "../agent-steps";
import {
  PREVIOUS_ERROR_HINT,
  STUCK_FALLBACK_REPLY,
  errorSignature,
  stuckNote,
} from "./loop-detector";
import { MAX_AGENT_STEPS } from "./constants";
import { drive, text, toolCall } from "./process-message.driver";

const FILE_ID = "k57b9c2xq1m4n8p0r3s6t9v2w5y8z1ab";
const NOT_FOUND = "Error: No files found with provided IDs. Use listFiles to get valid fileIDs.";

let recentMessages: unknown[] = [];
const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => recentMessages,
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectFilesWithUrls": () => [],
  "system:getProjectSkills": () => [],
  "system:getFileById": () => ({ _id: FILE_ID, name: "App.tsx", type: "file" }),
};

interface ChatBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
}

const codingRequests = (bodies: unknown[]) =>
  (bodies as ChatBody[]).filter((body) => body.messages[0]?.role === "system" && body.tools);

const finalUpdate = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:updateMessageContent")
    .map(([, args]) => args as Record<string, unknown>)
    .at(-1);

const rewrite = { data: toolCall("updateFile", { fileId: FILE_ID, content: "export default (" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.stubEnv("E2B_API_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  recentMessages = [];
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage loop detection", () => {
  it("stops a run that keeps writing a broken file with a no-tools explanation turn", async () => {
    const explanation = "I rewrote App.tsx three times and it still doesn't parse. Try restoring.";
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_SAME_SYNTAX_ERROR }, () => rewrite),
      { data: text(explanation) },
      // Never reached: the run ends after the explanation.
      rewrite,
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(MAX_SAME_SYNTAX_ERROR + 1);
    expect(requests.length).toBeLessThan(MAX_AGENT_STEPS);

    const update = finalUpdate();
    expect(update).toMatchObject({
      content: explanation,
      stuck: { reason: "repeated-syntax-error", fileId: FILE_ID, error: expect.stringContaining("App.tsx") },
    });
    const last = requests.at(-1);
    expect(last?.tool_choice).toBe("none");
    expect(last?.messages.at(-1)).toEqual({ role: "user", content: stuckNote(update?.stuck as never) });
  });

  it("never ends a stuck run with the generic reply", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      ...Array.from({ length: MAX_SAME_SYNTAX_ERROR }, () => rewrite),
      { data: { choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] } },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    expect(finalUpdate()).toMatchObject({ content: STUCK_FALLBACK_REPLY, stuck: { reason: "repeated-syntax-error" } });
  });

  it("hints once when the run hits the error the previous run got stuck on", async () => {
    recentMessages = [
      { _id: "u0", role: "user", content: "Fix the build" },
      { _id: "a0", role: "assistant", content: "Stuck.", stuck: { reason: "repeated-error", signature: errorSignature(NOT_FOUND) } },
      { _id: "u1", role: "user", content: "It's still broken" },
      { _id: "m1", role: "assistant", content: "" },
    ];
    QUERIES["system:getFileById"] = () => null;
    const missing = { data: toolCall("readFiles", { fileIds: ["nope"] }) };
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      missing,
      { data: text("Done.") },
    ]);
    QUERIES["system:getFileById"] = () => ({ _id: FILE_ID, name: "App.tsx", type: "file" });

    expect(outcome.finalType).toBe("function-resolved");
    const requests = codingRequests(outcome.inferenceBodies);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({ role: "user", content: PREVIOUS_ERROR_HINT });
    expect(JSON.stringify(requests[0].messages)).not.toContain(PREVIOUS_ERROR_HINT);
    expect(finalUpdate()).not.toHaveProperty("stuck");
  });
});

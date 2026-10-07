/**
 * BYOK runs of the real `processMessage` function under Inngest's execution
 * engine, replayed the way the platform does it (see step-isolation.test.ts for
 * the driver's rationale). Convex and the key unsealing are the only fakes.
 *
 * Proves that the decrypted key never lands in a persisted step result, that
 * inference goes to the user's provider, and that a rejected or invalid key
 * ends the run with a settings link instead of falling back to the platform.
 */

import { getFunctionName } from "convex/server";
import { StepMode } from "inngest/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "sk-user-secret-key-1234";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  openProviderKey: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/features/ai-providers/server/sealed-key", () => ({
  openProviderKey: mocks.openProviderKey,
}));
vi.mock("@/features/ai-providers/server/test-connection", () => ({
  testConnection: mocks.testConnection,
}));

import { inngest } from "@/inngest/client";

import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { processMessage } from "./process-message";

const key = {
  _id: "key_1",
  userId: "user_1",
  provider: "openai",
  label: "Work key",
  status: "active",
};

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: DEFAULT_CONVERSATION_TITLE }),
  "system:getRecentMessages": () => [],
  "system:getAiProviderKeyForRun": () => key,
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
};

/** Convex mutations the run performed, as `[name, args]`. */
const mutations = () =>
  mocks.mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args] as const);

const text = (content: string) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
});

/** One inference result: memoized data, or a failed AI gateway step. */
type Inference = { data: unknown } | { error: unknown };

interface Outcome {
  finalType: string;
  /** Every persisted step result (what Inngest stores). */
  stepState: Record<string, unknown>;
  /** URLs the AI gateway was asked to call. */
  inferenceUrls: string[];
}

async function drive(
  model: Record<string, unknown>,
  inferences: Inference[],
): Promise<Outcome> {
  const event = {
    name: "message/sent",
    data: {
      messageId: "m1",
      conversationId: "c1",
      projectId: "p1",
      message: "List my files",
      model,
    },
  };
  const stepState: Record<string, unknown> = {};
  const order: string[] = [];
  const inferenceUrls: string[] = [];
  let next = 0;

  for (let request = 0; request < 100; request += 1) {
    const execution = (
      processMessage as unknown as {
        createExecution: (o: { partialOptions: Record<string, unknown> }) => {
          start: () => Promise<Record<string, unknown>>;
        };
      }
    ).createExecution({
      partialOptions: {
        client: inngest,
        runId: "run-under-test",
        stepMode: StepMode.Async,
        data: { event, events: [event], runId: "run-under-test", attempt: 0 },
        stepState: { ...stepState },
        stepCompletionOrder: [...order],
        reqArgs: [],
        headers: {},
      },
    });

    const result = (await execution.start()) as {
      type: string;
      step?: { id: string; data?: unknown; error?: unknown };
      steps?: Array<{ id: string; op?: string; opts?: { url?: string } }>;
    };

    if (result.type === "step-ran" && result.step) {
      const { id, data, error } = result.step;
      stepState[id] = { id, ...(error ? { error } : { data }) };
      order.push(id);
      continue;
    }

    if (result.type === "steps-found" && result.steps) {
      for (const found of result.steps) {
        if (found.op === "AIGateway") {
          inferenceUrls.push(found.opts?.url ?? "");
          stepState[found.id] = { id: found.id, ...inferences[Math.min(next++, inferences.length - 1)] };
        } else if (found.op === "Sleep") {
          stepState[found.id] = { id: found.id, data: null };
        } else {
          throw new Error(`Unexpected op ${found.op}`);
        }
        order.push(found.id);
      }
      continue;
    }

    return { finalType: result.type, stepState, inferenceUrls };
  }
  throw new Error("Function did not settle");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Inngest's own API calls (checkpointing) are not under test.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
  mocks.openProviderKey.mockResolvedValue(SECRET);
  mocks.testConnection.mockResolvedValue({ ok: true });
});

describe("processMessage on the user's key", () => {
  it("runs on the user's provider and never persists the key in a step result", async () => {
    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, [
      { data: text("Listing files") },
      { data: text("Here are your files.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    const persisted = JSON.stringify(outcome.stepState);
    // The search covers real outputs (inference results included)...
    expect(persisted).toContain("Here are your files.");
    // ...and none of them carries the key.
    expect(persisted).not.toContain(SECRET);
    expect(outcome.inferenceUrls.length).toBeGreaterThan(0);
    for (const url of outcome.inferenceUrls) {
      expect(url).toContain("api.openai.com");
    }
    expect(mutations()).toEqual(
      expect.arrayContaining([
        ["system:markAiProviderKeyUsed", { internalKey: "ik", keyId: "key_1" }],
        ["system:updateConversationTitle", expect.objectContaining({ title: "Listing files" })],
        ["system:updateMessageContent", expect.objectContaining({ content: "Here are your files." })],
      ]),
    );
  });

  it.each([
    ["an error body the adapter rethrows", { data: { error: { message: "Incorrect API key provided" } } }],
    ["a failed gateway step", { error: { name: "Error", message: "AI request failed with status 401" } }],
  ])("marks a rejected key invalid and ends the run (%s)", async (_, rejection) => {
    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, [rejection]);

    expect(outcome.finalType).toBe("function-resolved");
    // No fallback: nothing was sent to the platform.
    expect(outcome.inferenceUrls.every((url) => !url.includes("openrouter"))).toBe(true);
    expect(mutations()).toEqual(
      expect.arrayContaining([
        [
          "system:updateAiProviderKeyStatus",
          expect.objectContaining({ keyId: "key_1", userId: "user_1", status: "invalid" }),
        ],
        [
          "system:updateMessageContent",
          expect.objectContaining({
            content: expect.stringContaining("(/settings/ai-providers)"),
          }),
        ],
      ]),
    );
    expect(JSON.stringify(outcome.stepState)).not.toContain(SECRET);
  });

  it("fails fast when the pre-flight check finds the key revoked", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      kind: "unauthorized",
      error: "OpenAI rejected the API key.",
    });

    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, []);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceUrls).toEqual([]);
    expect(mocks.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", apiKey: SECRET }),
    );
    expect(JSON.stringify(outcome.stepState)).not.toContain(SECRET);
    expect(mutations()).toEqual(
      expect.arrayContaining([
        ["system:updateAiProviderKeyStatus", expect.objectContaining({ status: "invalid" })],
        [
          "system:updateMessageContent",
          expect.objectContaining({ content: expect.stringContaining("/settings/ai-providers") }),
        ],
      ]),
    );
  });

  it("goes on to the inference when the provider is merely unreachable", async () => {
    mocks.testConnection.mockResolvedValue({
      ok: false,
      kind: "network",
      error: "Could not reach OpenAI.",
    });

    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, [
      { data: text("Title") },
      { data: text("Done.") },
    ]);

    expect(outcome.inferenceUrls.length).toBeGreaterThan(0);
    expect(mutations().map(([name]) => name)).not.toContain(
      "system:updateAiProviderKeyStatus",
    );
  });

  it("fails an invalid key straight away, with no inference", async () => {
    mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getAiProviderKeyForRun"
        ? { ...key, status: "invalid" }
        : QUERIES[getFunctionName(ref)]?.(),
    );

    const outcome = await drive({ keyId: "key_1", modelId: "gpt-6.1-sol" }, []);

    expect(outcome.finalType).toBe("function-resolved");
    expect(outcome.inferenceUrls).toEqual([]);
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
    expect(mutations()).toEqual([
      [
        "system:updateMessageContent",
        expect.objectContaining({ content: expect.stringContaining("/settings/ai-providers") }),
      ],
    ]);
  });

  it("keeps platform runs on OpenRouter", async () => {
    const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [
      { data: text("Title") },
      { data: text("Done.") },
    ]);

    expect(outcome.finalType).toBe("function-resolved");
    for (const url of outcome.inferenceUrls) {
      expect(url).toContain("openrouter.ai");
    }
    expect(mocks.openProviderKey).not.toHaveBeenCalled();
  });
});

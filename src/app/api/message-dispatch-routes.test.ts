import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  platform: vi.fn(),
  inngestSend: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return {
    convex: { query: withEnvPlatform(mocks.query, mocks.platform), mutation: mocks.mutation },
  };
});
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

import { POST as messagesPOST } from "./messages/route";
import { POST as cancelPOST } from "./messages/cancel/route";
import { POST as createWithPromptPOST } from "./projects/create-with-prompt/route";
import {
  DISPATCH_FAILED_ERROR,
  DISPATCH_FAILED_MESSAGE,
} from "@/lib/message-processor";
import {
  AGENT_MESSAGE_RATE_LIMIT,
  CREATE_WITH_PROMPT_RATE_LIMIT,
  checkRateLimit,
  resetRateLimits,
} from "@/lib/rate-limit";

const post = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
  });

const routes = [
  {
    name: "messages",
    call: (message = "Build a todo app", model?: string) =>
      messagesPOST(post({ conversationId: "c1", message, model })),
    successBody: { success: true, eventId: "evt_1", messageId: "m_assistant" },
    failureBody: { messageId: "m_assistant" },
    rateLimit: AGENT_MESSAGE_RATE_LIMIT,
  },
  {
    name: "projects/create-with-prompt",
    call: (prompt = "Build a todo app", model?: string) =>
      createWithPromptPOST(post({ prompt, model })),
    successBody: { projectId: "p1" },
    failureBody: { projectId: "p1" },
    rateLimit: CREATE_WITH_PROMPT_RATE_LIMIT,
  },
];

describe.each(routes)("POST /api/$name", ({ call, successBody, failureBody, rateLimit }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetRateLimits();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    // getOwnedConversation, then getProcessingMessages (messages route only).
    mocks.query
      .mockResolvedValueOnce({ _id: "c1", projectId: "p1" })
      .mockResolvedValueOnce([]);
    mocks.mutation.mockImplementation(async (_ref, args) => {
      if ("projectName" in args) return { projectId: "p1", conversationId: "c1" };
      if (args.role === "user") return "m_user";
      if (args.role === "assistant") return "m_assistant";
      return null;
    });
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("dispatches the assistant placeholder", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(successBody);
    expect(mocks.mutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: DISPATCH_FAILED_MESSAGE }),
    );
    // The key of process-message's per-user concurrency (#242).
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({ ownerId: "user_1" });
  });

  it("answers 503 ai_not_configured without the platform key, creating nothing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const res = await call();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "ai_not_configured" });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("answers 429 past the per-user limit without starting a run (#242)", async () => {
    for (let i = 0; i < rateLimit.limit; i++) checkRateLimit("user_1", rateLimit);

    const res = await call();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("answers 400 for a prompt over 50k characters (#242)", async () => {
    const res = await call("x".repeat(50_001));

    expect(res.status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  describe("on a promo model (ADR 0009)", () => {
    const OPUS = "anthropic/claude-opus-5.5";
    const runArgs = { internalKey: "test-key", userId: "user_1", kind: "opus" };
    const calledFn = (name: string) =>
      mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name);

    beforeEach(() => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      // The admin's catalog routes Opus to Anthropic, for promo claimants only.
      const model = {
        vendor: "v",
        vision: true,
        tools: "confirmed",
        pricing: { mode: "blended", usdPerMTok: 1 },
        hidden: false,
      };
      mocks.platform.mockReturnValue({
        models: [
          { ...model, id: "x-ai/grok-4.7", name: "Grok 4.7", provider: "openrouter", providerModelId: "x-ai/grok-4.7", access: "everyone" },
          { ...model, id: OPUS, name: "Claude Opus 5.5", provider: "anthropic", providerModelId: "claude-opus-5-5", access: "promo_counted" },
        ],
        defaultModelId: "x-ai/grok-4.7",
        utilityModelId: "x-ai/grok-4.7",
      });
      const answers: Record<string, unknown> = {
        "promoClaims:getForServer": { opusRunsUsed: 0 },
        "system:getOwnedConversation": { _id: "c1", projectId: "p1" },
        "system:getProcessingMessages": [],
      };
      mocks.query.mockImplementation(async (ref) => answers[getFunctionName(ref)]);
    });

    it("takes one Opus run and keeps it when the run starts", async () => {
      const res = await call(undefined, OPUS);

      expect(res.status).toBe(200);
      expect(calledFn("promoClaims:takeRun").map(([, args]) => args)).toEqual([runArgs]);
      expect(calledFn("promoClaims:refundRun")).toEqual([]);
      // The message records the route's provider (ADR 0010).
      expect(calledFn("system:createMessage").find(([, args]) => args.role === "assistant")?.[1])
        .toMatchObject({
          runModel: { modelId: OPUS, label: "Codenaya · Claude Opus 5.5", provider: "anthropic" },
        });
    });

    it("gives the run back when creating the send throws", async () => {
      const create = mocks.mutation.getMockImplementation()!;
      mocks.mutation.mockImplementation(async (ref, args) => {
        if (args.role === "user") throw new Error("Convex timeout");
        return create(ref, args);
      });

      await expect(call(undefined, OPUS)).rejects.toThrow("Convex timeout");
      expect(calledFn("promoClaims:refundRun").map(([, args]) => args)).toEqual([runArgs]);
      expect(mocks.inngestSend).not.toHaveBeenCalled();
    });

    it("gives the run back when dispatch fails", async () => {
      mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));

      const res = await call(undefined, OPUS);

      expect(res.status).toBe(502);
      expect(calledFn("promoClaims:refundRun").map(([, args]) => args)).toEqual([runArgs]);
    });
  });

  it("marks the placeholder failed and returns 502 when dispatch throws", async () => {
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));

    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: DISPATCH_FAILED_ERROR,
      code: "dispatch_failed",
      ...failureBody,
    });
    // `updateMessageContent` resolves the placeholder as completed with this text.
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      messageId: "m_assistant",
      content: DISPATCH_FAILED_MESSAGE,
    });
  });

  it("still returns 502 when marking the placeholder failed also fails", async () => {
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));
    const createMutation = mocks.mutation.getMockImplementation()!;
    mocks.mutation.mockImplementation(async (ref, args) => {
      if (args.content === DISPATCH_FAILED_MESSAGE) throw new Error("Convex unavailable");
      return createMutation(ref, args);
    });

    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "dispatch_failed" });
  });
});

describe("cancelling processing messages while the backend is down", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));
    mocks.mutation.mockImplementation(async (_ref, args) =>
      args.role === "assistant" ? "m_assistant" : null,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cancelledStuckMessage = () =>
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      messageId: "m_stuck",
      status: "cancelled",
    });

  it("Stop still marks the stuck message cancelled", async () => {
    // getOwnedProject, then getProcessingMessages.
    mocks.query
      .mockResolvedValueOnce({ _id: "p1", ownerId: "user_1" })
      .mockResolvedValueOnce([{ _id: "m_stuck" }]);

    const res = await cancelPOST(post({ projectId: "p1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled: true, messageIds: ["m_stuck"] });
    cancelledStuckMessage();
  });

  it("a new message clears the stuck one before reporting its own failure", async () => {
    mocks.query
      .mockResolvedValueOnce({ _id: "c1", projectId: "p1" })
      .mockResolvedValueOnce([{ _id: "m_stuck" }]);

    const res = await messagesPOST(post({ conversationId: "c1", message: "Hi" }));

    expect(res.status).toBe(502);
    cancelledStuckMessage();
  });
});

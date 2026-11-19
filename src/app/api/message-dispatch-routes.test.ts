import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  platform: vi.fn(),
  inngestSend: vi.fn(),
  resolveEnv: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return {
    convex: { query: withEnvPlatform(mocks.query, mocks.platform), mutation: mocks.mutation },
  };
});
vi.mock("@/features/integrations/server/env/resolve-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/integrations/server/env/resolve-env")>()),
  resolveProjectEnv: mocks.resolveEnv,
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));
// Spied, unchanged: plan and build share their routes, so only the task shows the difference.
vi.mock("@/features/ai-providers/auto-route", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/features/ai-providers/auto-route")>();
  return { ...original, autoRouteModel: vi.fn(original.autoRouteModel) };
});

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
import { PROMO_ENDS_AT } from "@/features/promotions/github-promo";
import { SWARM_OFF_ERROR } from "@/features/conversations/server/swarm-off";
import { autoRouteModel } from "@/features/ai-providers/auto-route";
import { REDACTION_UNAVAILABLE_NOTICE } from "@/features/integrations/server/env/stream-redactor";
import { buildFixPrompt } from "@/features/sandbox-preview/utils/app-error";

const post = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
  });

const routes = [
  {
    name: "messages",
    call: (message = "Build a todo app", model?: string, mode?: string) =>
      messagesPOST(post({ conversationId: "c1", message, model, mode })),
    successBody: { success: true, eventId: "evt_1", messageId: "m_assistant" },
    failureBody: { messageId: "m_assistant" },
    rateLimit: AGENT_MESSAGE_RATE_LIMIT,
  },
  {
    name: "projects/create-with-prompt",
    call: (prompt = "Build a todo app", model?: string, mode?: string) =>
      createWithPromptPOST(post({ prompt, model, mode })),
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

  it("runs a swarm reply in swarm mode, and refuses an unknown mode", async () => {
    // The kill switch's read comes first; it is on.
    mocks.query.mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ _id: "c1", projectId: "p1" })
      .mockResolvedValueOnce([]);
    expect((await call(undefined, undefined, "swarm")).status).toBe(200);
    expect(getFunctionName(mocks.query.mock.calls[0][0])).toBe("swarm:isEnabled");
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "assistant", mode: "swarm" }));
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({ mode: "swarm" });

    expect((await call(undefined, undefined, "hive")).status).toBe(400);
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("runs an Ask / Plan reply in plan mode", async () => {
    expect((await call(undefined, undefined, "plan")).status).toBe(200);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "assistant", mode: "plan" }));
    expect(mocks.inngestSend.mock.calls[0][0].data).toMatchObject({ mode: "plan" });
  });

  it("refuses a swarm send with a clear error while the kill switch is off, creating nothing", async () => {
    mocks.query.mockReset().mockResolvedValueOnce(false);

    const res = await call(undefined, undefined, "swarm");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SWARM_OFF_ERROR, code: "swarm_disabled" });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
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
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(PROMO_ENDS_AT - 24 * 60 * 60 * 1000);
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

    afterEach(() => {
      vi.useRealTimers();
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
    // `updateMessageContent` resolves the placeholder as completed with this
    // text, and the run counts as failed in the activation events (#339).
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      messageId: "m_assistant",
      content: DISPATCH_FAILED_MESSAGE,
      outcome: "error",
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

describe("POST /api/messages with Auto (#322)", () => {
  const FIRST_BUILD = "projects:conversationNeedsFirstBuildForServer";
  let firstBuild: () => Promise<boolean>;
  const send = (model: string, message = "Make the header blue") =>
    messagesPOST(post({ conversationId: "c1", message, model }));
  const queried = (name: string) =>
    mocks.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, args]) => args);
  const recordedRunModel = () =>
    mocks.mutation.mock.calls.find(([, args]) => args.role === "assistant")?.[1].runModel;

  beforeEach(() => {
    vi.resetAllMocks();
    resetRateLimits();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    firstBuild = async () => false;
    const answers: Record<string, () => unknown> = {
      [FIRST_BUILD]: () => firstBuild(),
      "system:getOwnedConversation": () => ({ _id: "c1", projectId: "p1" }),
      "system:getProcessingMessages": () => [],
    };
    mocks.query.mockImplementation(async (ref) => answers[getFunctionName(ref)]?.());
    mocks.mutation.mockImplementation(async (_ref, args) =>
      args.role === "assistant" ? "m_assistant" : null,
    );
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the first-build state and routes a short follow-up as an edit", async () => {
    const res = await send("auto");

    expect(res.status).toBe(200);
    expect(queried(FIRST_BUILD)).toEqual([{ internalKey: "test-key", conversationId: "c1" }]);
    expect(recordedRunModel()).toEqual({
      modelId: "openai/gpt-6-luna",
      label: "Auto · GPT-6 Luna",
      provider: "openrouter",
    });
    // The run gets the concrete model, never "auto".
    expect(mocks.inngestSend.mock.calls[0][0].data.model).toMatchObject({ modelId: "openai/gpt-6-luna" });
  });

  it("routes a short retry before the first build finished as a build", async () => {
    firstBuild = async () => true;

    await send("auto", "try again");

    expect(recordedRunModel()).toMatchObject({ modelId: "anthropic/claude-sonnet-5.5" });
  });

  it("routes as a build when the first-build read fails", async () => {
    firstBuild = async () => {
      throw new Error("Convex unavailable");
    };

    const res = await send("auto");

    expect(res.status).toBe(200);
    expect(recordedRunModel()).toMatchObject({ label: "Auto · Claude Sonnet 5.5" });
  });

  it("refuses an image send when Auto's pool has no vision model, creating nothing", async () => {
    const pooled = (id: string, vision: boolean) => ({
      id,
      name: id,
      vendor: "v",
      provider: "openrouter",
      providerModelId: id,
      vision,
      tools: "confirmed",
      pricing: { mode: "blended", usdPerMTok: 1 },
      access: "everyone",
      hidden: false,
    });
    mocks.platform.mockReturnValue({
      models: [pooled("text-only", false), pooled("seer", true)],
      defaultModelId: "seer",
      utilityModelId: "seer",
      autoModelIds: ["text-only"],
    });

    const res = await messagesPOST(
      post({ conversationId: "c1", message: "Match this", model: "auto", images: ["data:image/png;base64,AA=="] }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Auto has no image-capable model. Pick a model that can read images.",
      code: "auto_no_vision_model",
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("routes an Ask / Plan first run on Auto as a plan, and any other as a build", async () => {
    const tasks = () => vi.mocked(autoRouteModel).mock.calls.map(([, task]) => task);
    mocks.mutation.mockImplementation(async (_ref, args) =>
      "projectName" in args ? { projectId: "p1", conversationId: "c1" } : args.role === "assistant" ? "m_assistant" : null,
    );

    expect((await createWithPromptPOST(post({ prompt: "Plan a todo app", model: "auto", mode: "plan" }))).status).toBe(200);
    expect(tasks()).toEqual(["plan"]);

    vi.mocked(autoRouteModel).mockClear();
    await createWithPromptPOST(post({ prompt: "Fix it", model: "auto" }));
    expect(tasks()).toEqual(["build"]);
  });

  it("makes no extra read for a model the user picked", async () => {
    const res = await send("x-ai/grok-4.7");

    expect(res.status).toBe(200);
    expect(queried(FIRST_BUILD)).toEqual([]);
    expect(recordedRunModel()).toMatchObject({ modelId: "x-ai/grok-4.7" });
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

describe("POST /api/messages with a preview fix prompt", () => {
  const CANARY = "dummy-canary-fix-prompt-0001";
  const forms = [CANARY, Buffer.from(CANARY).toString("base64"), Buffer.from(CANARY).toString("hex")];
  // Overlay text from the preview sandbox, and terminal lines the stream already redacted.
  const fix = buildFixPrompt(
    { kind: "runtime", message: `bad DSN ${forms[0]}`, stack: `at ${forms[1]}\nat ${forms[2]}` },
    "API_KEY=[redacted]\n",
  );
  const send = (message: string) => messagesPOST(post({ conversationId: "c1", message }));
  const stored = () => mocks.mutation.mock.calls.find(([, args]) => args.role === "user")?.[1].content as string;
  const dispatched = () => mocks.inngestSend.mock.calls[0][0].data.message as string;

  beforeEach(() => {
    vi.resetAllMocks();
    resetRateLimits();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    const answers: Record<string, () => unknown> = {
      "system:getOwnedConversation": () => ({ _id: "c1", projectId: "p1" }),
      "system:getProcessingMessages": () => [],
      "system:getEnvVarsForSandbox": () => [{ _id: "env_1", key: "DATABASE_URL", visibility: "secret" }],
    };
    mocks.query.mockImplementation(async (ref) => answers[getFunctionName(ref)]?.());
    mocks.mutation.mockImplementation(async (_ref, args) => (args.role === "assistant" ? "m_assistant" : null));
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
    mocks.resolveEnv.mockResolvedValue({ publicEntries: [], secretEntries: [{ key: "DATABASE_URL", value: CANARY }], failedKeys: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stores and dispatches it with the project's values masked, raw, base64 or hex", async () => {
    expect((await send(fix)).status).toBe(200);

    for (const text of [stored(), dispatched()]) {
      expect(text).toContain("bad DSN [redacted]");
      for (const form of forms) expect(text).not.toContain(form);
    }
  });

  it("leaves the placeholders it already holds intact", async () => {
    mocks.resolveEnv.mockResolvedValue({ publicEntries: [], secretEntries: [{ key: "SHORT", value: "act" }], failedKeys: [] });

    await send(fix);

    expect(stored()).toContain("API_KEY=[redacted]");
  });

  it("sends the notice instead when the project's values cannot be opened", async () => {
    mocks.resolveEnv.mockRejectedValue(new Error("CODENAYA_LOCAL_KEK is not set"));

    await send(fix);

    expect(stored()).toBe(REDACTION_UNAVAILABLE_NOTICE);
    expect(dispatched()).toBe(REDACTION_UNAVAILABLE_NOTICE);
  });

  it("leaves any other message as it is, without opening the values", async () => {
    await send(`Use ${CANARY} as the title`);

    expect(stored()).toBe(`Use ${CANARY} as the title`);
    expect(mocks.resolveEnv).not.toHaveBeenCalled();
  });
});

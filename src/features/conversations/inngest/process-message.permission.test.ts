import { getFunctionName } from "convex/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), permission: vi.fn(), catalog: vi.fn() }));
vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform, withPlatformPermission } = await import("@/features/ai-providers/server/active-platform.mock");
  const mutation = withPlatformPermission(mocks.mutation);
  return { convex: {
    query: withEnvPlatform(mocks.query, mocks.catalog),
    mutation: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      getFunctionName(ref) === "billingEntitlement:permissionForServer" ? mocks.permission(args) : mutation(ref, args),
  } };
});
import { PERMISSION_STOP_REPLY } from "@/features/billing/server/platform-permission";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { swarmWorker } from "./swarm-worker";
import { drive, toolCall } from "./process-message.driver";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-fake");
  vi.stubEnv("CODENAYA_BILLING_ENABLED", "");
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
  mocks.query.mockImplementation(async (ref) => {
    switch (getFunctionName(ref)) {
      case "system:getProjectById": return { ownerId: "actual-owner" };
      case "system:getConversationById": return { title: "Existing title" };
      default: return [];
    }
  });
  mocks.mutation.mockResolvedValue(null);
  mocks.permission.mockResolvedValue({ plan: "free", platformAllowed: true, reason: null });
});

it.each(["on_hold", "deleted", "expiry", "reversal"])("rehydrates completed usage after %s; dispatches no next inference", async (reason) => {
  vi.stubEnv("CODENAYA_BILLING_ENABLED", "true");
  const model = (id: string) => ({ id, name: id, vendor: "x", provider: "openrouter", providerModelId: id, vision: false, tools: "reported", access: "everyone", hidden: false });
  mocks.catalog.mockReturnValue({ models: [model("default"), model("paid")], defaultModelId: "default", utilityModelId: "default" });
  let held = false;
  const inference = toolCall("listFiles");
  // The engine reads the canned gateway result after dispatch, before replaying onResponse.
  const completed = { get data() {
    held = true;
    return { ...inference, usage: { prompt_tokens: 1000, completion_tokens: 1000 } };
  } };
  mocks.permission.mockImplementation(async () => ({ plan: held ? "free" : "pro", platformAllowed: !held || reason === "expiry" || reason === "reversal", reason: held && (reason === "on_hold" || reason === "deleted") ? reason : null }));
  const outcome = await drive({ modelId: "paid" }, [completed]);
  expect(outcome.finalType).toBe("function-resolved");
  expect(outcome.inferenceBodies).toHaveLength(1);
  const records = mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "credits:recordRunUsage");
  expect(records.length).toBeGreaterThan(0);
  expect(records.at(-1)?.[1]).toMatchObject({ inputTokens: 1000, outputTokens: 1000 });
  const reply = mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:updateMessageContent")?.[1];
  expect(reply.content).toBe(PERMISSION_STOP_REPLY);
});

it("blocks both parallel title and coding on refusal without dispatching a provider", async () => {
  mocks.query.mockImplementation(async (ref) => getFunctionName(ref) === "system:getProjectById" ? { ownerId: "owner" }
    : getFunctionName(ref) === "system:getConversationById" ? { title: DEFAULT_CONVERSATION_TITLE } : []);
  mocks.permission.mockResolvedValue({ plan: "pro", platformAllowed: false, reason: "on_hold" });
  const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: toolCall("listFiles") }]);
  expect(outcome.inferenceBodies).toHaveLength(0);
});

it("blocks a worker and its summary/self-check after permission refusal", async () => {
  mocks.mutation.mockImplementation(async (ref) => getFunctionName(ref) === "agentTasks:startTask"
    ? { taskId: "pages", brief: "Build pages", ownedPaths: ["src/pages"], modelId: "x-ai/grok-4.7", role: "worker" } : null);
  mocks.permission.mockResolvedValue({ plan: "pro", platformAllowed: false, reason: "deleted" });
  const outcome = await drive({ modelId: "x-ai/grok-4.7" }, [{ data: toolCall("listFiles") }], "", {
    parentMessageId: "m1", agentTaskId: "t1", ownerId: "spoofed", planOverview: "Plan",
  }, { fn: swarmWorker });
  expect(outcome.inferenceBodies).toHaveLength(0);
  expect(outcome.data).toMatchObject({ status: "unfinished", summary: PERMISSION_STOP_REPLY });
});

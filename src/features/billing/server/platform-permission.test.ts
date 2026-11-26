import { expect, it, vi } from "vitest";
import { api } from "../../../../convex/_generated/api";
const mutation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/convex-client", () => ({ convex: { mutation } }));
import { readPlatformPermission } from "./platform-permission";
it("uses the authoritative mutation without passing a client clock", async () => {
  const view = { plan: "pro", creditsLeft: 3400 };
  mutation.mockResolvedValueOnce(view);
  expect(await readPlatformPermission({ internalKey: "ik", userId: "owner" })).toBe(view);
  expect(mutation).toHaveBeenCalledWith(api.billingEntitlement.getForServer, { internalKey: "ik", userId: "owner" });
});
it("propagates outages rather than manufacturing permission", async () => {
  mutation.mockRejectedValueOnce(new Error("Policy unavailable"));
  await expect(readPlatformPermission({ internalKey: "ik", userId: "owner" })).rejects.toThrow("Policy unavailable");
});

// The middleware gate must allow completed memo rehydration even after revocation.
import { createAgent } from "@inngest/agent-kit";
import { Inngest, Middleware } from "inngest";
import { InferencePermissionMiddleware, permissionGate, PERMISSION_FRESH_MS } from "./platform-permission";
import type { Id } from "../../../../convex/_generated/dataModel";

it("fails closed for fresh inference without trusted context, but permits completed memo", async () => {
  const middleware = new InferencePermissionMiddleware({ client: new Inngest({ id: "permission-test" }) });
  const args = { stepInfo: { stepType: "ai.infer", memoized: false }, stepOptions: { id: "agent" }, input: [] } as unknown as Middleware.TransformStepInputArgs;
  await expect(middleware.transformStepInput(args)).rejects.toThrow();
  const memo = { ...args, stepInfo: { ...args.stepInfo, memoized: true } };
  expect(await middleware.transformStepInput(memo)).toBe(memo);
});

it("composes a run scope without replacing its prompt hook and expires permission within 30s", async () => {
  vi.stubEnv("CODENAYA_BILLING_ENABLED", "");
  const query = vi.fn().mockImplementation(async (ref) => ref === api.system.getProjectById ? { ownerId: "owner" } : null);
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-fake");
  // Each call below is the same public middleware hook a fresh gateway dispatch uses.
  const { convex } = await import("@/lib/convex-client");
  Object.assign(convex, { query });
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  mutation.mockResolvedValue({ plan: "pro", platformAllowed: true, reason: null });
  const gate = permissionGate({ internalKey: "ik", projectId: "p1" as Id<"projects">, source: "platform" });
  const onStart = vi.fn();
  const middleware = new InferencePermissionMiddleware({ client: new Inngest({ id: "permission-test" }) });
  const args = { stepInfo: { stepType: "ai.infer", memoized: false }, stepOptions: { id: "agent" }, input: [] } as unknown as Middleware.TransformStepInputArgs;
  const infer = vi.fn(async () => middleware.transformStepInput(args));
  const agent = createAgent({ name: "worker", system: "test", lifecycle: { onStart } });
  agent.run = infer as unknown as typeof agent.run;
  gate.wrap(agent, "x-ai/grok-4.7");
  await agent.run("first");
  await agent.run("cached");
  const reads = mutation.mock.calls.filter(([ref]) => ref === api.billingEntitlement.permissionForServer).length;
  expect(reads).toBe(1);
  now.mockReturnValue(1000 + PERMISSION_FRESH_MS);
  mutation.mockResolvedValue({ plan: "pro", platformAllowed: false, reason: "on_hold" });
  await expect(agent.run("revoked")).rejects.toThrow();
  expect(gate.stopped).toBe(true);
  expect(agent.lifecycles).toMatchObject({ onStart });
  now.mockRestore();
});

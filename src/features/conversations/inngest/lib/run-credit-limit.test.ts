import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn() }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("@/features/billing/server/platform-permission", () => ({ readPlatformPermission: mocks.permission }));
import { runCreditLimit } from "./run-credit-limit";
import type { Id } from "../../../../../convex/_generated/dataModel";
const run = (source: "platform" | "promo" | "byok" = "platform") => runCreditLimit("ik", "p1" as Id<"projects">, source);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ ownerId: "real_owner" });
  mocks.permission.mockResolvedValue({ billingEnabled: false, platformAllowed: true, creditsLeft: 1 });
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "true");
});
afterEach(() => vi.unstubAllEnvs());
it("does not read or limit BYOK credits", async () => {
  expect(await run("byok")).toBeNull();
  expect(mocks.query).not.toHaveBeenCalled();
});
it("preserves legacy flag-off budget", async () => {
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
  expect(await run()).toBeNull();
});
it("snapshots the authoritative real owner's balance", async () => {
  expect(await run()).toBe(1);
  expect(mocks.permission).toHaveBeenCalledWith({ internalKey: "ik", userId: "real_owner" });
});
it.each(["", "false", "true"])("enforces enabled paid/Free availability with legacy flag %s", async (flag) => {
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", flag);
  mocks.permission.mockResolvedValue({ billingEnabled: true, platformAllowed: true, creditsLeft: 3400 });
  expect(await run()).toBe(3400);
  mocks.permission.mockResolvedValue({ billingEnabled: true, platformAllowed: true, creditsLeft: 0 });
  expect(await run()).toBe(0);
});
it("does not apply an ordinary budget to promo", async () => {
  expect(await run("promo")).toBeNull();
});
it.each(["platform", "promo"] as const)("refuses holds and deletion for %s even with flag off", async (source) => {
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "false");
  for (const reason of ["on_hold", "deleted"]) {
    mocks.permission.mockResolvedValue({ platformAllowed: false, reason });
    await expect(run(source)).rejects.toThrow();
  }
});
it("fails closed for missing/deleting projects and policy outages", async () => {
  mocks.query.mockResolvedValue(null);
  await expect(run()).rejects.toThrow("Project not found");
  mocks.query.mockResolvedValue({ ownerId: "real_owner", deletingAt: 1 });
  await expect(run()).rejects.toThrow("Project not found");
  mocks.query.mockResolvedValue({ ownerId: "real_owner" });
  mocks.permission.mockRejectedValue(new Error("Policy unavailable"));
  await expect(run()).rejects.toThrow("Policy unavailable");
});

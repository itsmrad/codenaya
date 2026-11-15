import { beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));

import { runCreditLimit } from "./run-credit-limit";
import type { Id } from "../../../../../convex/_generated/dataModel";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "true");
});

it.each(["byok", "promo"] as const)("does not read or limit %s credits", async (source) => {
  expect(await runCreditLimit("ik", "p1" as Id<"projects">, source)).toBeNull();
  expect(mocks.query).not.toHaveBeenCalled();
});

it("does not limit platform runs before enforcement is enabled", async () => {
  vi.stubEnv("CREDIT_LIMITS_ENFORCED", "");
  expect(await runCreditLimit("ik", "p1" as Id<"projects">, "platform")).toBeNull();
  expect(mocks.query).not.toHaveBeenCalled();
});

it("uses the stored project owner and the smaller remaining cap", async () => {
  const now = new Date();
  mocks.query.mockImplementation(async (ref) => getFunctionName(ref) === "system:getProjectById"
    ? { ownerId: "real_owner" }
    : { plan: "free", periodStartsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), periodUsed: 299,
      dayStartsAt: new Date(now).setUTCHours(0, 0, 0, 0), dayUsed: 0 });
  expect(await runCreditLimit("ik", "p1" as Id<"projects">, "platform")).toBe(1);
  expect(mocks.query).toHaveBeenLastCalledWith(expect.anything(), { internalKey: "ik", userId: "real_owner" });
});

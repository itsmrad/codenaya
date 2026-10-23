// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import { userPlanId } from "./planLimits";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN = { subject: "user_admin", email: "admin@example.com", emailVerified: true };

const asAdmin = () => convexTest(schema, modules).withIdentity(ADMIN);

const audit = async (t: ReturnType<typeof asAdmin>) =>
  (await t.query(api.platformModels.listAudit, { paginationOpts: { numItems: 10, cursor: null } })).page;

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAIL", ADMIN.email);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("planLimits", () => {
  test("lists every plan with its PLANS default until saved", async () => {
    expect(await asAdmin().query(api.planLimits.listPlanLimits, {})).toEqual([
      { planId: "free", costLimitMicroUsd: 3_000_000, isDefault: true },
      { planId: "pro", costLimitMicroUsd: 20_000_000, isDefault: true },
    ]);
  });

  test("saves caps as micro-USD and writes one audit row with before and after", async () => {
    const t = asAdmin();
    await t.mutation(api.planLimits.setPlanLimits, { planId: "free", monthlyUsdLimit: 5, monthlyTokenLimit: 2_000_000 });

    expect((await t.query(api.planLimits.listPlanLimits, {}))[0]).toEqual({
      planId: "free",
      costLimitMicroUsd: 5_000_000,
      tokenLimit: 2_000_000,
      isDefault: false,
    });
    const rows = await audit(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "planLimits.set",
      actorEmail: ADMIN.email,
      summary: "Free: USD $3.00, tokens none → USD $5.00, tokens 2,000,000 (was the default)",
    });
  });

  test("turning a cap off removes it from the row", async () => {
    const t = asAdmin();
    await t.mutation(api.planLimits.setPlanLimits, { planId: "pro", monthlyUsdLimit: 5, monthlyTokenLimit: 10 });
    await t.mutation(api.planLimits.setPlanLimits, { planId: "pro", monthlyTokenLimit: 10 });

    expect((await t.query(api.planLimits.listPlanLimits, {}))[1]).toEqual({
      planId: "pro",
      tokenLimit: 10,
      isDefault: false,
    });
  });

  test.each([
    ["USD -1", { monthlyUsdLimit: -1 }],
    ["USD NaN", { monthlyUsdLimit: Number.NaN }],
    ["USD 10,001", { monthlyUsdLimit: 10_001 }],
    ["tokens 1.5", { monthlyTokenLimit: 1.5 }],
    ["tokens -1", { monthlyTokenLimit: -1 }],
    ["tokens 10^10", { monthlyTokenLimit: 1e10 }],
  ])("rejects %s", async (_, limits) => {
    await expect(
      asAdmin().mutation(api.planLimits.setPlanLimits, { planId: "free", ...limits }),
    ).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
  });

  test("rejects an unknown plan", async () => {
    await expect(
      asAdmin().mutation(api.planLimits.setPlanLimits, { planId: "enterprise" as "free" }),
    ).rejects.toThrow();
  });

  test("a non-admin gets NOT_FOUND and changes nothing", async () => {
    const t = convexTest(schema, modules);
    const user = t.withIdentity({ subject: "user_1", email: "user@example.com", emailVerified: true });
    await expect(user.mutation(api.planLimits.setPlanLimits, { planId: "free" })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    await expect(user.query(api.planLimits.listPlanLimits, {})).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    expect(await t.run((ctx) => ctx.db.query("planLimits").take(1))).toEqual([]);
  });

  test("everyone is on Free until billing (#105) stores a plan", async () => {
    await convexTest(schema, modules).run(async (ctx) => {
      expect(await userPlanId(ctx, "user_1")).toBe("free");
    });
  });
});

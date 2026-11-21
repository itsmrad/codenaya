// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { readAccountEntitlement } from "./billingEntitlement";
import { insertGrant, MAX_ACTIVE_LOTS, rollOverIntoPeriod } from "./billingGrants";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const NOW = Date.UTC(2026, 9, 29, 10);
const DAY = 24 * 60 * 60 * 1000;
const mode = "test_mode" as const;

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

type AccountFields = { periodUsed?: number; creditDebt?: number; freeMonthStartsAt?: number; freeUsed?: number; freeDebtOffset?: number };
/** October's Free allocation already spent, so charges go straight to lots. */
const FREE_SPENT: AccountFields = { freeMonthStartsAt: Date.UTC(2026, 9, 1), freeUsed: 300, freeDebtOffset: 0 };

/** A billing customer and credit account for Alice; `versioned` turns paid lots on. */
const seed = (t: TestConvex, versioned = true, plan: "free" | "pro" = "pro", fields: AccountFields = FREE_SPENT) =>
  t.run(async (ctx) => {
    await ctx.db.insert("creditAccounts", {
      userId: ALICE, plan, periodStartsAt: Date.UTC(2026, 9, 1), periodUsed: 0,
      dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 0, ...(versioned ? { paidCreditsVersion: 1 as const, paidCreditsMode: mode, ...fields } : {}),
    });
    return await ctx.db.insert("billingCustomers", {
      mode, ownerTokenIdentifier: `https://clerk.synthetic|${ALICE}`, userId: ALICE,
      creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
    });
  });

type Lot = { kind: "current_period" | "rollover" | "top_up"; quantity: number; expiresAt?: number; revoked?: number };
const grant = (t: TestConvex, customerRef: Id<"billingCustomers">, sourceKey: string, lot: Lot) =>
  t.run(async (ctx) => {
    const expiresAt = lot.expiresAt ?? NOW + 30 * DAY;
    const interval = lot.kind === "current_period" ? { serviceStart: NOW - DAY, serviceEnd: expiresAt } : {};
    const id = await insertGrant(ctx, { mode, sourceKey, customerRef, kind: lot.kind, quantity: lot.quantity, expiresAt, ...interval });
    if (lot.revoked) await ctx.db.patch("billingGrants", id, { revoked: lot.revoked });
    return id;
  });

const seedMessage = (t: TestConvex) =>
  t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: 1 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 1 });
    return await ctx.db.insert("messages", {
      conversationId, projectId, role: "assistant", content: "", status: "processing",
      runModel: { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    });
  });

/** Records a platform run whose running cost is `costUsd`: 150 credits per dollar. */
const charge = (t: TestConvex, messageId: Id<"messages">, costUsd: number, agentTaskId?: Id<"agentTasks">) =>
  t.mutation(api.credits.recordRunUsage, {
    internalKey: INTERNAL_KEY, messageId, agentTaskId, source: "platform", inputTokens: 1000, outputTokens: 100, costUsd,
  });

const seedWorker = (t: TestConvex, messageId: Id<"messages">) =>
  t.run(async (ctx) =>
    ctx.db.insert("agentTasks", {
      messageId, projectId: (await ctx.db.get("messages", messageId))!.projectId, taskId: "t1", role: "worker",
      title: "Worker", brief: "Do it", ownedPaths: [], modelId: "gpt-5.6-luna", model: "GPT-5.6 Luna",
      status: "running", steps: [], updatedAt: 1,
    }),
  );

const consumed = (t: TestConvex) =>
  t.run(async (ctx) => (await ctx.db.query("billingGrants").take(200)).map((row) => [row.sourceKey, row.consumed]));
const lotBy = (t: TestConvex, sourceKey: string) =>
  t.run((ctx) => ctx.db.query("billingGrants").withIndex("by_mode_and_sourceKey", (q) => q.eq("mode", mode).eq("sourceKey", sourceKey)).unique());
const rawAccount = (t: TestConvex) =>
  t.run((ctx) => ctx.db.query("creditAccounts").withIndex("by_userId", (q) => q.eq("userId", ALICE)).unique());

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("insertGrant", () => {
  test("is idempotent per mode and source key, and conflicts on changed terms", async () => {
    const t = setup();
    const customerRef = await seed(t);
    const first = await grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 2000 });
    expect(await grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 2000 })).toBe(first);
    await expect(grant(t, customerRef, "period:sub_1:a:b", { kind: "current_period", quantity: 1000 })).rejects.toThrow(/conflicts/);
    await expect(grant(t, customerRef, "period:sub_1:a:b", { kind: "top_up", quantity: 2000 })).rejects.toThrow(/conflicts/);
    expect(await t.run((ctx) => ctx.db.query("billingGrants").take(5))).toMatchObject([
      { userId: ALICE, quantity: 2000, consumed: 0, revoked: 0 },
    ]);
  });

  test("rejects invalid terms and a customer from another mode", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await expect(grant(t, customerRef, " ", { kind: "top_up", quantity: 1000 })).rejects.toThrow(/Invalid/);
    await expect(grant(t, customerRef, "k", { kind: "top_up", quantity: 0.5 })).rejects.toThrow(/Invalid/);
    const source = await grant(t, customerRef, "src", { kind: "current_period", quantity: 10 });
    await expect(
      t.run((ctx) => insertGrant(ctx, { mode, sourceKey: "k", customerRef, kind: "top_up", quantity: 1, expiresAt: NOW + DAY, sourceGrantRef: source })),
    ).rejects.toThrow(/Invalid/);
    await expect(
      t.run((ctx) => insertGrant(ctx, { mode, sourceKey: "k", customerRef, kind: "current_period", quantity: 1, expiresAt: NOW + DAY })),
    ).rejects.toThrow(/Invalid/);
    await expect(
      t.run((ctx) =>
        insertGrant(ctx, { mode, sourceKey: "k", customerRef, kind: "current_period", quantity: 1, expiresAt: NOW + 2 * DAY, serviceStart: NOW, serviceEnd: NOW + DAY }),
      ),
    ).rejects.toThrow(/Invalid/);
    await expect(
      t.run((ctx) => insertGrant(ctx, { mode: "live_mode", sourceKey: "k", customerRef, kind: "top_up", quantity: 1, expiresAt: NOW + DAY })),
    ).rejects.toThrow(/conflicts/);
  });
});

describe("paid credit allocation in recordRunUsage", () => {
  test.each(["free", "pro"] as const)("a %s account without paidCreditsVersion is charged exactly as before", async (plan) => {
    const t = setup();
    const customerRef = await seed(t, false, plan);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 });
    const messageId = await seedMessage(t);
    await charge(t, messageId, 0.1);

    expect(await rawAccount(t)).toEqual({
      _id: expect.any(String), _creationTime: expect.any(Number), userId: ALICE, plan, periodStartsAt: Date.UTC(2026, 9, 1), periodUsed: 15,
      dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 15,
    });
    expect(await consumed(t)).toEqual([["top", 0]]);
  });

  test("spends new credits in order, and a replayed total spends nothing more", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "top_late", { kind: "top_up", quantity: 10, expiresAt: NOW + 90 * DAY });
    await grant(t, customerRef, "top_early", { kind: "top_up", quantity: 10, expiresAt: NOW + 60 * DAY });
    await grant(t, customerRef, "roll", { kind: "rollover", quantity: 3 });
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 6 });
    const messageId = await seedMessage(t);

    await charge(t, messageId, 0.04); // 6 credits
    await charge(t, messageId, 0.1); // 15 in all: 9 more
    await charge(t, messageId, 0.1); // replay
    await charge(t, messageId, 0.04); // older step replayed

    expect(await consumed(t)).toEqual([["top_late", 0], ["top_early", 6], ["roll", 3], ["cur", 6]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 15, dayUsed: 15, creditDebt: 0 });
  });

  test("skips expired and revoked lots by server time", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "expired", { kind: "current_period", quantity: 100, expiresAt: NOW });
    await grant(t, customerRef, "revoked", { kind: "rollover", quantity: 100, revoked: 100 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 100 });
    await charge(t, await seedMessage(t), 0.1);
    expect(await consumed(t)).toEqual([["expired", 0], ["revoked", 0], ["top", 15]]);
  });

  test("records what lots can't cover as debt, keeping full usage", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 10 });
    const first = await seedMessage(t);
    const second = await seedMessage(t);

    await charge(t, first, 0.04); // 6
    await charge(t, second, 0.04); // 6 more: the lot has only 4 left
    await charge(t, second, 0.04); // replay

    expect(await consumed(t)).toEqual([["cur", 10]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 12, creditDebt: 2 });
  });

  test("dictation spends paid lots too", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 10 });
    await t.mutation(api.credits.recordTranscriptionUsage, { internalKey: INTERNAL_KEY, userId: ALICE, costUsd: 0.02 });
    expect(await consumed(t)).toEqual([["top", 3]]);
  });

  test("interleaved runs spend the same lots once, in order", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 5 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 10 });
    const a = await seedMessage(t);
    const b = await seedMessage(t);

    await charge(t, a, 0.02); // 3
    await charge(t, b, 0.02); // 3
    await charge(t, a, 0.04); // 3 more
    await charge(t, b, 0.04); // 3 more

    expect(await consumed(t)).toEqual([["cur", 5], ["top", 7]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 12, creditDebt: 0 });
  });

  test("a swarm worker's own ledger row spends lots too", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 20 });
    const messageId = await seedMessage(t);
    await charge(t, messageId, 0.04); // 6
    await charge(t, messageId, 0.02, await seedWorker(t, messageId)); // 3 on the worker's row
    expect(await consumed(t)).toEqual([["top", 9]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 9 });
  });

  test("spends only lots of the account's billing mode", async () => {
    const t = setup();
    const customerRef = await seed(t);
    const liveRef = await t.run((ctx) =>
      ctx.db.insert("billingCustomers", {
        mode: "live_mode", ownerTokenIdentifier: `https://clerk.synthetic|${ALICE}`, userId: ALICE,
        creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
      }),
    );
    await t.run((ctx) =>
      insertGrant(ctx, { mode: "live_mode", sourceKey: "live", customerRef: liveRef, kind: "top_up", quantity: 100, expiresAt: NOW + DAY }),
    );
    await grant(t, customerRef, "test", { kind: "top_up", quantity: 2 });
    await charge(t, await seedMessage(t), 0.04); // 6
    expect(await consumed(t)).toEqual([["live", 0], ["test", 2]]);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 6, creditDebt: 4 });
  });

  test("debt outlives a calendar period reset within a paid period", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 2, expiresAt: Date.UTC(2026, 10, 15) });
    await charge(t, await seedMessage(t), 0.04); // 6: 4 uncovered

    vi.setSystemTime(Date.UTC(2026, 10, 2));
    await charge(t, await seedMessage(t), 0.02); // 3, the period lot is spent
    expect(await rawAccount(t)).toMatchObject({ periodStartsAt: Date.UTC(2026, 10, 1), periodUsed: 3, creditDebt: 7, ...FREE_SPENT });
  });

  test.each(["current_period", "rollover"] as const)(
    "a capped %s kind spends its read lots, never later kinds, and records the rest as debt",
    async (kind) => {
      const t = setup();
      const customerRef = await seed(t);
      for (let i = 1; i <= MAX_ACTIVE_LOTS[kind] + 1; i++) {
        await grant(t, customerRef, `${kind}_${i}`, { kind, quantity: 2, expiresAt: NOW + i * DAY });
      }
      await grant(t, customerRef, "top", { kind: "top_up", quantity: 100 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await charge(t, await seedMessage(t), 0.04); // 6: the 2 read lots cover 4

      expect(await consumed(t)).toEqual([[`${kind}_1`, 2], [`${kind}_2`, 2], [`${kind}_3`, 0], ["top", 0]]);
      expect(await rawAccount(t)).toMatchObject({ periodUsed: 6, creditDebt: 2 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`userId=${ALICE} .*kind=${kind}`)));
      warn.mockRestore();
    },
  );

  test("past the cap of unspent top-ups, the read lots are spent and the rest becomes debt with full usage", async () => {
    const t = setup();
    const customerRef = await seed(t);
    for (let i = 0; i <= MAX_ACTIVE_LOTS.top_up; i++) {
      await grant(t, customerRef, `top_${String(i).padStart(3, "0")}`, { kind: "top_up", quantity: 1, expiresAt: NOW + (i + 1) * DAY });
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await charge(t, await seedMessage(t), 1); // 150: the 100 read lots cover 100
    const spent = (await consumed(t)).filter(([, n]) => n === 1).map(([key]) => key);
    expect(spent).toHaveLength(MAX_ACTIVE_LOTS.top_up);
    expect(spent).not.toContain(`top_${MAX_ACTIVE_LOTS.top_up}`);
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 150, creditDebt: 50 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/kind=top_up/));
    warn.mockRestore();
  });

  test("spent lots don't count toward the cap", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_ACTIVE_LOTS.top_up; i++) {
        await ctx.db.insert("billingGrants", {
          mode, sourceKey: `spent_${i}`, customerRef, userId: ALICE, kind: "top_up", quantity: 1, consumed: 1, revoked: 0,
          expiresAt: NOW + DAY, exhausted: true,
        });
      }
    });
    await grant(t, customerRef, "fresh", { kind: "top_up", quantity: 10, expiresAt: NOW + 2 * DAY });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await charge(t, await seedMessage(t), 0.04); // 6
    expect(await lotBy(t, "fresh")).toMatchObject({ consumed: 6 });
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 0 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("marks a lot exhausted exactly when a spend leaves nothing", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "a", { kind: "top_up", quantity: 6, expiresAt: NOW + DAY });
    await grant(t, customerRef, "b", { kind: "top_up", quantity: 10, expiresAt: NOW + 2 * DAY });
    await charge(t, await seedMessage(t), 0.06); // 9
    expect(await lotBy(t, "a")).toMatchObject({ consumed: 6, exhausted: true });
    expect(await lotBy(t, "b")).toMatchObject({ consumed: 3 });
    expect((await lotBy(t, "b"))!.exhausted).toBeUndefined();
  });

  test("a top-up outlives the period lot", async () => {
    const t = setup();
    const customerRef = await seed(t);
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 100, expiresAt: NOW + DAY });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 100, expiresAt: NOW + 365 * DAY });
    vi.setSystemTime(NOW + 2 * DAY);
    await charge(t, await seedMessage(t), 0.04); // 6
    expect(await consumed(t)).toEqual([["cur", 0], ["top", 6]]);
  });

  test.each([{ paidCreditsVersion: 1 as const }, { paidCreditsMode: mode }])(
    "an account with only %o set is charged exactly as before",
    async (half) => {
      const t = setup();
      const customerRef = await seed(t, false);
      await t.run(async (ctx) => ctx.db.patch("creditAccounts", (await ctx.db.query("creditAccounts").first())!._id, half));
      await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 });
      await charge(t, await seedMessage(t), 0.1);
      expect(await rawAccount(t)).toEqual({
        _id: expect.any(String), _creationTime: expect.any(Number), userId: ALICE, plan: "pro", periodStartsAt: Date.UTC(2026, 9, 1),
        periodUsed: 15, dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 15, ...half,
      });
      expect(await consumed(t)).toEqual([["top", 0]]);
    },
  );
});

const setDebt = (t: TestConvex, creditDebt: number) =>
  t.run(async (ctx) => ctx.db.patch("creditAccounts", (await ctx.db.query("creditAccounts").first())!._id, { creditDebt }));

describe("debt offset by a new grant", () => {
  test("a top-up pays off debt once, and the rest is spendable", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "pro", { ...FREE_SPENT, creditDebt: 500 });
    const top = await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 });
    expect(await lotBy(t, "top")).toMatchObject({ debtOffset: 500 });
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 0 });

    await setDebt(t, 300);
    expect(await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 })).toBe(top); // replay
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 300 });

    await setDebt(t, 0);
    await charge(t, await seedMessage(t), 4); // 600: 500 left on the lot
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 500, debtOffset: 500, exhausted: true });
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 100 });
  });

  test("a period grant offsets debt too, and a full offset exhausts the lot", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "pro", { ...FREE_SPENT, creditDebt: 1500 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 1000 });
    await grant(t, customerRef, "cur", { kind: "current_period", quantity: 2000 });
    expect(await lotBy(t, "top")).toMatchObject({ debtOffset: 1000, exhausted: true });
    expect(await lotBy(t, "cur")).toMatchObject({ debtOffset: 500 });
    expect((await lotBy(t, "cur"))!.exhausted).toBeUndefined();
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 0 });
  });

  test("a rollover, a grant in another mode, or a legacy account offsets nothing", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "pro", { ...FREE_SPENT, creditDebt: 500 });
    await grant(t, customerRef, "roll", { kind: "rollover", quantity: 100 });
    const liveRef = await t.run((ctx) =>
      ctx.db.insert("billingCustomers", {
        mode: "live_mode", ownerTokenIdentifier: `https://clerk.synthetic|${ALICE}`, userId: ALICE,
        creationState: "ready", generation: 0, inputRevision: 0, unresolvedReceipts: 0,
      }),
    );
    await t.run((ctx) =>
      insertGrant(ctx, { mode: "live_mode", sourceKey: "live", customerRef: liveRef, kind: "top_up", quantity: 100, expiresAt: NOW + DAY }),
    );
    expect((await t.run((ctx) => ctx.db.query("billingGrants").take(5))).map((row) => row.debtOffset)).toEqual([undefined, undefined]);
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 500 });

    const legacy = setup();
    const legacyRef = await seed(legacy, false);
    await setDebt(legacy, 500);
    await grant(legacy, legacyRef, "top", { kind: "top_up", quantity: 100 });
    expect((await lotBy(legacy, "top"))!.debtOffset).toBeUndefined();
  });
});

describe("rollOverIntoPeriod", () => {
  const P0 = NOW - 30 * DAY;
  const P1 = NOW;
  const P2 = NOW + 30 * DAY;
  const MINUTE = 60_000;
  const period = (t: TestConvex, customerRef: Id<"billingCustomers">, sourceKey: string, start: number, end: number, quantity = 2000) =>
    t.run((ctx) =>
      insertGrant(ctx, { mode, sourceKey, customerRef, kind: "current_period", quantity, expiresAt: end, serviceStart: start, serviceEnd: end }),
    );
  const rollOver = (t: TestConvex, ref: Id<"billingGrants">) => t.run((ctx) => rollOverIntoPeriod(ctx, ref, Date.now()));
  const rollovers = (t: TestConvex) =>
    t.run(async (ctx) => (await ctx.db.query("billingGrants").take(20)).filter((row) => row.kind === "rollover"));

  test("an on-time renewal carries the ended period's unspent credits once", async () => {
    vi.setSystemTime(P0 + DAY); // convex-test creation times never go back
    const t = setup();
    const customerRef = await seed(t);
    const source = await period(t, customerRef, "p0", P0, P1);
    await charge(t, await seedMessage(t), 0.6); // 90 of 2000

    vi.setSystemTime(P1 + MINUTE); // the source has just expired
    const next = await period(t, customerRef, "p1", P1, P2);
    const rollover = await rollOver(t, next);
    expect(await rollOver(t, next)).toBe(rollover); // replay
    expect(await rollovers(t)).toMatchObject([
      { _id: rollover, sourceKey: "rollover:p0", quantity: 1910, expiresAt: P2, sourceGrantRef: source, customerRef },
    ]);
    expect(await lotBy(t, "p0")).toMatchObject({ consumed: 90, transferred: 1910, exhausted: true });

    // Both lots together spend no more than the period granted.
    await charge(t, await seedMessage(t), 30); // 4500
    expect(await lotBy(t, "p1")).toMatchObject({ consumed: 2000 });
    expect(await lotBy(t, "rollover:p0")).toMatchObject({ consumed: 1910 });
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 590 });
  });

  test("caps the rollover at 2,000 credits", async () => {
    vi.setSystemTime(P0 + DAY); // convex-test creation times never go back
    const t = setup();
    const customerRef = await seed(t);
    await period(t, customerRef, "p0", P0, P1, 3000);
    vi.setSystemTime(P1 + MINUTE);
    await rollOver(t, await period(t, customerRef, "p1", P1, P2));
    expect(await rollovers(t)).toMatchObject([{ quantity: 2000 }]);
    const left = await lotBy(t, "p0");
    expect(left).toMatchObject({ transferred: 2000 });
    expect(left!.exhausted).toBeUndefined();
  });

  test("nothing rolls into a period that already ended, or from a source granted after its end", async () => {
    vi.setSystemTime(P0 + DAY); // convex-test creation times never go back
    const t = setup();
    const customerRef = await seed(t);
    await period(t, customerRef, "p0", P0, P1);
    vi.setSystemTime(P2 + MINUTE);
    expect(await rollOver(t, await period(t, customerRef, "p1", P1, P2))).toBeNull();

    vi.setSystemTime(P1 + MINUTE);
    const late = setup();
    const lateRef = await seed(late);
    await period(late, lateRef, "p0", P0, P1);
    expect(await rollOver(late, await period(late, lateRef, "p1", P1, P2))).toBeNull();
    expect([...(await rollovers(t)), ...(await rollovers(late))]).toEqual([]);
  });

  test("a rollover is never carried again", async () => {
    const P3 = P2 + 30 * DAY;
    vi.setSystemTime(P0 + DAY);
    const t = setup();
    const customerRef = await seed(t);
    await period(t, customerRef, "p0", P0, P1, 1000);
    vi.setSystemTime(P1 + MINUTE);
    await rollOver(t, await period(t, customerRef, "p1", P1, P2));
    await charge(t, await seedMessage(t), 15); // 2250: all of p1, 250 of the 1000 rollover

    vi.setSystemTime(P2 + MINUTE);
    expect(await rollOver(t, await period(t, customerRef, "p2", P2, P3))).toBeNull();
    expect(await rollovers(t)).toMatchObject([{ sourceKey: "rollover:p0", consumed: 250 }]);
  });

  test("an early renewal's period lot is neither spent nor shown before it starts, then is spent first", async () => {
    vi.stubEnv("CODENAYA_DEPLOYMENT", "development");
    vi.setSystemTime(P0 + DAY); // convex-test creation times never go back
    const t = setup();
    const customerRef = await seed(t);
    await t.run((ctx) => ctx.db.insert("users", { clerkUserId: ALICE, updatedAt: 1 }));
    await period(t, customerRef, "p0", P0, P1, 3000);
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500, expiresAt: P2 + 60 * DAY });
    const view = () => t.run((ctx) => readAccountEntitlement(ctx, ALICE, Date.now()));

    vi.setSystemTime(P1 - DAY); // the renewal settles a day early
    await rollOver(t, await period(t, customerRef, "p1", P1, P2));
    await charge(t, await seedMessage(t), 21); // 3150: the rest of p0, its rollover, then the top-up
    expect(await consumed(t)).toEqual([["p0", 1000], ["top", 150], ["p1", 0], ["rollover:p0", 2000]]);
    expect(await rawAccount(t)).toMatchObject({ creditDebt: 0 });
    expect(await view()).toMatchObject({ plan: "pro", paidCreditsRemaining: 350, creditsLeft: 350, nextChangeAt: P1 });

    vi.setSystemTime(P1 + MINUTE);
    expect(await view()).toMatchObject({ plan: "pro", paidCreditsRemaining: 2350, creditsLeft: 2350 });
    await charge(t, await seedMessage(t), 0.1); // 15 from the new period first
    expect(await lotBy(t, "p1")).toMatchObject({ consumed: 15 });
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 150 });
  });

  test("rejects a target that isn't a period grant", async () => {
    const t = setup();
    const customerRef = await seed(t);
    const top = await grant(t, customerRef, "top", { kind: "top_up", quantity: 10 });
    await expect(rollOver(t, top)).rejects.toThrow(/period grant/);
  });
});

describe("Free allocation first", () => {
  test("a fresh month's allocation is spent before paid lots, then lots, then debt", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "free", {});
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500 });
    await charge(t, await seedMessage(t), 2.1); // 315: 300 Free, 15 from the top-up
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 15 });
    expect(await rawAccount(t)).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 9, 1), freeUsed: 300, freeDebtOffset: 0, creditDebt: 0 });
  });

  test("enabling mid-month after 300 legacy credits grants no more Free that month", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "free", { periodUsed: 300 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500 });
    await charge(t, await seedMessage(t), 0.1); // 15, all from the top-up
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 15 });
    expect(await rawAccount(t)).toMatchObject({ periodUsed: 315, freeMonthStartsAt: Date.UTC(2026, 9, 1), freeUsed: 300 });
  });

  test("enabling mid-month after 120 legacy credits leaves 180 Free", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "free", { periodUsed: 120 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500 });
    await charge(t, await seedMessage(t), 2.1); // 315: 180 Free, 135 from the top-up
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 135 });
    expect(await rawAccount(t)).toMatchObject({ freeUsed: 300, creditDebt: 0 });
  });

  test("legacy usage from an earlier month doesn't reduce this month's Free", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "free", { periodUsed: 300 });
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500, expiresAt: NOW + 60 * DAY });
    vi.setSystemTime(Date.UTC(2026, 10, 2));
    await charge(t, await seedMessage(t), 0.1); // 15 Free
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 0 });
    expect(await rawAccount(t)).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 10, 1), freeUsed: 15, periodUsed: 15 });
  });

  test("a non-billing account with legacy usage is charged exactly as before", async () => {
    const t = setup();
    const customerRef = await seed(t, false, "free");
    await t.run(async (ctx) => ctx.db.patch("creditAccounts", (await ctx.db.query("creditAccounts").first())!._id, { periodUsed: 300 }));
    await grant(t, customerRef, "top", { kind: "top_up", quantity: 500 });
    await charge(t, await seedMessage(t), 0.1);
    expect(await rawAccount(t)).toEqual({
      _id: expect.any(String), _creationTime: expect.any(Number), userId: ALICE, plan: "free", periodStartsAt: Date.UTC(2026, 9, 1),
      periodUsed: 315, dayStartsAt: Date.UTC(2026, 9, 29), dayUsed: 15,
    });
    expect(await lotBy(t, "top")).toMatchObject({ consumed: 0 });
  });

  test("a new month offsets debt once, and charges beyond it become debt", async () => {
    const t = setup();
    await seed(t, true, "free", { ...FREE_SPENT, creditDebt: 500 });
    vi.setSystemTime(Date.UTC(2026, 10, 2));
    await charge(t, await seedMessage(t), 0.1); // 15, no lots
    expect(await rawAccount(t)).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 10, 1), freeUsed: 0, freeDebtOffset: 300, creditDebt: 215 });
    await charge(t, await seedMessage(t), 0.1); // 15 more, same month
    expect(await rawAccount(t)).toMatchObject({ freeUsed: 0, freeDebtOffset: 300, creditDebt: 230 });
  });

  test("a paid period neither touches nor resets the month's Free allocation", async () => {
    const t = setup();
    const customerRef = await seed(t, true, "free", {});
    await charge(t, await seedMessage(t), 0.6); // 90 Free
    await t.run((ctx) =>
      insertGrant(ctx, {
        mode, sourceKey: "cur", customerRef, kind: "current_period", quantity: 10,
        expiresAt: NOW + DAY, serviceStart: NOW, serviceEnd: NOW + DAY,
      }),
    );
    await charge(t, await seedMessage(t), 0.1); // 15: 10 from the period, 5 debt even once it is spent
    expect(await lotBy(t, "cur")).toMatchObject({ consumed: 10, exhausted: true });
    expect(await rawAccount(t)).toMatchObject({ freeUsed: 90, creditDebt: 5 });

    vi.setSystemTime(NOW + 2 * DAY); // still October, the period has ended
    await charge(t, await seedMessage(t), 0.1); // 15 Free
    expect(await rawAccount(t)).toMatchObject({ freeMonthStartsAt: Date.UTC(2026, 9, 1), freeUsed: 105, freeDebtOffset: 0, creditDebt: 5 });
  });
});

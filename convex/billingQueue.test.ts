// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertBillingFence } from "./billing";
import {
  LEASE_MS, MAX_ATTEMPTS, MAX_RECEIPTS_PER_CLAIM, MAX_SWEEP_RECEIPTS, RETRY_BASE_MS, retryDelayMs,
} from "./billingQueue";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const START = Date.parse("2026-11-19T00:00:00Z");
const DIGEST = "a".repeat(64);
type Mode = "test_mode" | "live_mode";

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  return convexTest(schema, modules);
}
type TestBackend = ReturnType<typeof setup>;

async function readyCustomer(t: TestBackend, userId = "user_alice", mode: Mode = "test_mode") {
  await t.run(async ctx => {
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", q => q.eq("clerkUserId", userId)).unique();
    if (!user) await ctx.db.insert("users", { clerkUserId: userId, updatedAt: 1 });
  });
  const customerRef = await t.mutation(internal.billing.ensureCustomer, { mode, userId, ownerTokenIdentifier: `https://clerk.synthetic|${userId}` });
  await t.mutation(internal.billing.bindCustomer, { customerRef, customerId: `cus_${userId}` });
  return customerRef;
}

const receipt = (webhookId = "wh_1", mode: Mode = "test_mode") =>
  ({ mode, webhookId, eventType: "payment.succeeded", bodyDigest: DIGEST, occurredAt: 1, paymentId: "pay_synthetic" });
const record = (t: TestBackend, customerRef: Id<"billingCustomers"> | undefined, webhookId = "wh_1", mode: Mode = "test_mode") =>
  t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt(webhookId, mode) });
const claim = (t: TestBackend, customerRef: Id<"billingCustomers">) => t.mutation(internal.billingQueue.claimCustomer, { customerRef });
const release = (t: TestBackend, customerRef: Id<"billingCustomers">, generation: number) =>
  t.mutation(internal.billingQueue.releaseCustomer, { customerRef, generation });
const readCustomer = (t: TestBackend, customerRef: Id<"billingCustomers">) => t.run(ctx => ctx.db.get("billingCustomers", customerRef));
const readEvent = (t: TestBackend, eventRef: Id<"billingEvents">) => t.run(ctx => ctx.db.get("billingEvents", eventRef));
const pendingRuns = (t: TestBackend, name: string) => t.run(async ctx =>
  (await ctx.db.system.query("_scheduled_functions").take(200)).filter(run => run.state.kind === "pending" && run.name.endsWith(name)));
const fenceOf = (t: TestBackend, customerRef: Id<"billingCustomers">, captured: { generation: number; inputRevision: number }) =>
  t.run(ctx => assertBillingFence(ctx, customerRef, captured));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("receipt scheduling", () => {
  test("a mapped receipt schedules one run atomically; duplicates and invalid receipts schedule nothing", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await record(t, customerRef);
    expect(await pendingRuns(t, "processCustomer")).toMatchObject([{ args: [{ customerRef }] }]);
    await record(t, customerRef);
    await expect(t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt("wh_bad"), bodyDigest: "raw" })).rejects.toThrow("Invalid normalized");
    expect(await pendingRuns(t, "processCustomer")).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.query("billingEvents").take(3))).toHaveLength(1);
  });

  test("unmapped, ignored and digest-collision receipts schedule nothing and record why", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const unmapped = await record(t, undefined, "wh_unmapped");
    const ignored = await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt("wh_ignored"), eventType: "credit.added", ignored: true });
    expect(await pendingRuns(t, "processCustomer")).toEqual([]);
    const collided = await record(t, customerRef);
    await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt(), bodyDigest: "b".repeat(64) });
    expect(await pendingRuns(t, "processCustomer")).toHaveLength(1);
    expect(await readEvent(t, unmapped)).toMatchObject({ state: "quarantined", quarantineReason: "unmapped" });
    expect(await readEvent(t, ignored)).toMatchObject({ state: "ignored" });
    expect(await readEvent(t, ignored)).not.toHaveProperty("quarantineReason");
    expect(await readEvent(t, collided)).toMatchObject({ state: "quarantined", quarantineReason: "digest_mismatch" });
  });
});

describe("customer lease", () => {
  test("a claim takes the lease, backs off only due receipts and blocks a second claim", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const due = await record(t, customerRef, "wh_due");
    const later = await record(t, customerRef, "wh_later");
    await t.run(ctx => ctx.db.patch("billingEvents", later, { nextAttemptAt: START + 60 * 60_000 }));
    const batch = await claim(t, customerRef);
    expect(batch).toMatchObject({ mode: "test_mode", generation: 1, inputRevision: 2, customerId: "cus_user_alice" });
    expect(batch?.receipts.map(r => r.eventRef)).toEqual([due, later]);
    expect(batch?.receipts[0]).toEqual({ eventRef: due, eventType: "payment.succeeded", paymentId: "pay_synthetic" });
    expect(await readCustomer(t, customerRef)).toMatchObject({ generation: 1, leaseExpiresAt: START + LEASE_MS });
    expect((await readEvent(t, due))?.attempts).toBe(1);
    expect((await readEvent(t, due))?.nextAttemptAt).toBeGreaterThanOrEqual(START + RETRY_BASE_MS);
    expect(await readEvent(t, later)).toMatchObject({ attempts: 0, nextAttemptAt: START + 60 * 60_000 });
    expect(await claim(t, customerRef)).toBeNull();
    vi.setSystemTime(START + 5 * 60_000);
    expect(await claim(t, customerRef)).toBeNull();
  });

  test("a crashed worker is overtaken after its lease and fenced out by generation", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const eventRef = await record(t, customerRef);
    const stale = await claim(t, customerRef);
    const staleFence = { generation: stale!.generation, inputRevision: stale!.inputRevision };
    vi.setSystemTime(START + LEASE_MS + 1);
    const before = (await pendingRuns(t, "processCustomer")).length;
    await t.mutation(internal.billingQueue.sweepReceipts, {});
    expect(await pendingRuns(t, "processCustomer")).toHaveLength(before + 1);
    const fresh = await claim(t, customerRef);
    expect(fresh?.generation).toBe(stale!.generation + 1);
    await t.run(async ctx => {
      await ctx.db.patch("billingEvents", eventRef, { state: "processed" });
      await ctx.db.patch("billingCustomers", customerRef, { unresolvedReceipts: 0 });
    });
    await expect(fenceOf(t, customerRef, staleFence)).rejects.toThrow("conflicts");
    await fenceOf(t, customerRef, { generation: fresh!.generation, inputRevision: fresh!.inputRevision });
  });

  test("a stale release leaves the newer lease intact", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await record(t, customerRef);
    const stale = await claim(t, customerRef);
    vi.setSystemTime(START + LEASE_MS + 1);
    const fresh = await claim(t, customerRef);
    await release(t, customerRef, stale!.generation);
    expect(await readCustomer(t, customerRef)).toMatchObject({ generation: fresh!.generation, leaseExpiresAt: START + 2 * LEASE_MS + 1 });
  });

  test("a receipt recorded during a lease is picked up right after release", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await record(t, customerRef, "wh_first");
    const first = await claim(t, customerRef);
    const second = await record(t, customerRef, "wh_second");
    expect(await claim(t, customerRef)).toBeNull();
    const before = (await pendingRuns(t, "processCustomer")).length;
    await release(t, customerRef, first!.generation);
    const runs = await pendingRuns(t, "processCustomer");
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)?.scheduledTime).toBeLessThanOrEqual(Date.now());
    expect((await claim(t, customerRef))?.receipts.map(r => r.eventRef)).toContain(second);
    expect((await readEvent(t, second))?.attempts).toBe(1);
  });

  test.each([{ hold: true }, { deletedAt: 1 }])("a %o customer is still claimable", async state => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    await record(t, customerRef);
    await t.run(ctx => ctx.db.patch("billingCustomers", customerRef, state));
    expect(await claim(t, customerRef)).toMatchObject({ generation: 1, receipts: [{ eventType: "payment.succeeded" }] });
  });

  test("a claim sees only its own customer's receipts across modes", async () => {
    const t = setup();
    const refs = [];
    for (const mode of ["test_mode", "live_mode"] as const) {
      const customerRef = await readyCustomer(t, "user_alice", mode);
      refs.push({ mode, customerRef, eventRef: await record(t, customerRef, "wh_same", mode) });
    }
    for (const { mode, customerRef, eventRef } of refs) {
      expect(await claim(t, customerRef)).toMatchObject({ mode, receipts: [{ eventRef, paymentId: "pay_synthetic" }] });
    }
  });

  test("a backlog claims one bounded batch and reschedules immediately for the rest", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const eventRefs = [];
    for (let i = 0; i < MAX_RECEIPTS_PER_CLAIM + 5; i++) eventRefs.push(await record(t, customerRef, `wh_${i}`));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = await claim(t, customerRef);
    expect(batch?.receipts.map(r => r.eventRef)).toEqual(eventRefs.slice(0, MAX_RECEIPTS_PER_CLAIM));
    expect(errors).toHaveBeenCalledWith("[billingQueue] receipt backlog", { customerRef });
    const before = (await pendingRuns(t, "processCustomer")).length;
    await release(t, customerRef, batch!.generation);
    const runs = await pendingRuns(t, "processCustomer");
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)?.scheduledTime).toBe(Date.now());
    expect((await readCustomer(t, customerRef))?.leaseExpiresAt).toBeUndefined();
  });
});

describe("retry, dead-letter and redrive", () => {
  test("retryDelayMs is bounded, monotonic without jitter and jitters at most 20%", () => {
    const cap = 6 * 60 * 60_000;
    expect(retryDelayMs(0, () => 0)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(1, () => 0)).toBe(RETRY_BASE_MS);
    let previous = 0;
    for (let attempts = 0; attempts <= 40; attempts++) {
      const delay = retryDelayMs(attempts, () => 0);
      const jittered = retryDelayMs(attempts, () => 0.999);
      expect(delay).toBeGreaterThanOrEqual(Math.max(previous, RETRY_BASE_MS));
      expect(jittered).toBeGreaterThanOrEqual(delay);
      expect(jittered).toBeLessThanOrEqual(Math.min(delay * 1.2, cap));
      previous = delay;
    }
    expect(retryDelayMs(40, () => 0)).toBe(cap);
  });

  test("an unreconciled receipt dead-letters after MAX_ATTEMPTS claims and stays unresolved", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventRef = await record(t, customerRef);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await readEvent(t, eventRef)).toMatchObject({ state: "quarantined", quarantineReason: "retries_exhausted", attempts: MAX_ATTEMPTS });
    expect(await readCustomer(t, customerRef)).toMatchObject({ generation: MAX_ATTEMPTS, unresolvedReceipts: 1 });
    expect((await readCustomer(t, customerRef))?.leaseExpiresAt).toBeUndefined();
    expect(await pendingRuns(t, "processCustomer")).toEqual([]);
    const fence = await t.query(internal.billing.getFence, { customerRef });
    await expect(fenceOf(t, customerRef, fence)).rejects.toThrow("conflicts");
    expect(errors).toHaveBeenCalledWith("[billingQueue] receipt dead-lettered", { eventRef, eventType: "payment.succeeded", attempts: MAX_ATTEMPTS });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(new RegExp(`${DIGEST}|pay_synthetic|cus_`));
  });

  test("redrive returns a mapped quarantined receipt to pending without recounting it", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const eventRef = await record(t, customerRef);
    await t.mutation(internal.billing.recordReceipt, { customerRef, ...receipt(), bodyDigest: "b".repeat(64) });
    vi.setSystemTime(START + 1000);
    const before = await readCustomer(t, customerRef);
    await t.mutation(internal.billingQueue.redriveReceipt, { eventRef });
    const event = await readEvent(t, eventRef);
    expect(event).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: START + 1000 });
    expect(event).not.toHaveProperty("quarantineReason");
    expect(await readCustomer(t, customerRef)).toMatchObject({
      inputRevision: before!.inputRevision + 1, unresolvedReceipts: before!.unresolvedReceipts,
    });
    expect(await pendingRuns(t, "processCustomer")).toHaveLength(2);
  });

  test("redrive rejects unmapped, processed and pending receipts", async () => {
    const t = setup();
    const customerRef = await readyCustomer(t);
    const unmapped = await record(t, undefined, "wh_unmapped");
    const pending = await record(t, customerRef, "wh_pending");
    const processed = await record(t, customerRef, "wh_processed");
    await t.run(ctx => ctx.db.patch("billingEvents", processed, { state: "processed" }));
    for (const eventRef of [unmapped, pending, processed]) {
      await expect(t.mutation(internal.billingQueue.redriveReceipt, { eventRef })).rejects.toThrow("Only a mapped quarantined");
    }
  });
});

describe("sweep", () => {
  test("pages past a leased backlog to reach other customers, skipping leased and unmapped", async () => {
    const t = setup();
    const leased = await readyCustomer(t);
    const other = await readyCustomer(t, "user_bob");
    await record(t, undefined, "wh_unmapped");
    await t.run(async ctx => {
      await ctx.db.patch("billingCustomers", leased, { leaseExpiresAt: START + LEASE_MS });
      const row = { mode: "test_mode" as const, eventType: "payment.succeeded", occurredAt: 1, receivedAt: 1, bodyDigest: DIGEST,
        state: "pending" as const, attempts: 1, generation: 0 };
      for (let i = 0; i < MAX_SWEEP_RECEIPTS + 5; i++) {
        await ctx.db.insert("billingEvents", { ...row, customerRef: leased, webhookId: `wh_leased_${i}`, nextAttemptAt: START - 1000 });
      }
      await ctx.db.insert("billingEvents", { ...row, customerRef: other, webhookId: "wh_other", nextAttemptAt: START });
      await ctx.db.insert("billingEvents", { ...row, customerRef: other, webhookId: "wh_not_due", nextAttemptAt: START + 60_000 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.mutation(internal.billingQueue.sweepReceipts, {});
    expect(await pendingRuns(t, "processCustomer")).toEqual([]);
    expect(await pendingRuns(t, "sweepReceipts")).toHaveLength(1);
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    expect(await pendingRuns(t, "processCustomer")).toMatchObject([{ args: [{ customerRef: other }] }]);
    expect(await pendingRuns(t, "sweepReceipts")).toEqual([]);
  });
});

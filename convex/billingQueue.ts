import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { reconcileClaim } from "./billingReconcile";
import { appError } from "./errors";
import { billingModeValidator, billingResourceIdsValidator } from "./schema";

export const LEASE_MS = 11 * 60_000; // > Convex's 10-minute action limit, so only a crashed worker is overtaken
export const RETRY_BASE_MS = 60_000;
export const MAX_ATTEMPTS = 10; // claims before dead-letter
export const ALERT_AFTER_ATTEMPTS = 5;
export const MAX_RECEIPTS_PER_CLAIM = 25;
export const MAX_SWEEP_RECEIPTS = 100; // one sweep page
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

const claimValidator = v.object({
  mode: billingModeValidator,
  generation: v.number(),
  inputRevision: v.number(),
  customerId: v.union(v.string(), v.null()),
  receipts: v.array(v.object({ eventRef: v.id("billingEvents"), eventType: v.string(), ...billingResourceIdsValidator.fields })),
});
export type Claim = Infer<typeof claimValidator>;

/** Pure. RETRY_BASE_MS doubled per attempt; capped; up to +20% jitter. Never below RETRY_BASE_MS. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
  return Math.min(Math.round(base * (1 + 0.2 * random())), MAX_RETRY_DELAY_MS);
}

/** Schedules processCustomer; call only inside a mutation. */
export async function scheduleCustomer(ctx: MutationCtx, customerRef: Id<"billingCustomers">, delayMs = 0): Promise<void> {
  await ctx.scheduler.runAfter(delayMs, internal.billingQueue.processCustomer, { customerRef });
}

const isLeased = (customer: Doc<"billingCustomers">, now: number) => (customer.leaseExpiresAt ?? 0) > now;
// Ordered by nextAttemptAt, so the first row is the earliest due.
const pendingReceipts = (ctx: QueryCtx, customerRef: Id<"billingCustomers">) => ctx.db.query("billingEvents")
  .withIndex("by_customerRef_and_state_and_nextAttemptAt", q => q.eq("customerRef", customerRef).eq("state", "pending"));

export const claimCustomer = internalMutation({
  args: { customerRef: v.id("billingCustomers") },
  returns: v.union(v.null(), claimValidator),
  handler: async (ctx, { customerRef }) => {
    const now = Date.now();
    const customer = await ctx.db.get("billingCustomers", customerRef);
    if (!customer || isLeased(customer, now)) return null;
    const pending = await pendingReceipts(ctx, customerRef).take(MAX_RECEIPTS_PER_CLAIM + 1);
    const earliest = pending[0];
    if (!earliest || earliest.nextAttemptAt > now) return null;
    const backlog = pending.length > MAX_RECEIPTS_PER_CLAIM;
    if (backlog) console.error("[billingQueue] receipt backlog", { customerRef });
    const receipts: Claim["receipts"] = [];
    for (const receipt of pending.slice(0, MAX_RECEIPTS_PER_CLAIM)) {
      const log = { eventRef: receipt._id, eventType: receipt.eventType, attempts: receipt.attempts };
      if (receipt.nextAttemptAt <= now) {
        if (receipt.attempts >= MAX_ATTEMPTS) {
          // Still counted in unresolvedReceipts: a dead letter keeps the fence closed until redriven.
          await ctx.db.patch("billingEvents", receipt._id, { state: "quarantined", quarantineReason: "retries_exhausted" });
          console.error("[billingQueue] receipt dead-lettered", log);
          continue;
        }
        const attempts = receipt.attempts + 1;
        await ctx.db.patch("billingEvents", receipt._id, { attempts, nextAttemptAt: now + retryDelayMs(attempts) });
        if (attempts >= ALERT_AFTER_ATTEMPTS) console.error("[billingQueue] receipt retrying", { ...log, attempts });
      }
      // Not-yet-due receipts join unchanged: reconciliation must see the whole unresolved set.
      const { _id, eventType, paymentId, subscriptionId, sessionId } = receipt;
      receipts.push({ eventRef: _id, eventType, paymentId, subscriptionId, sessionId });
    }
    if (!receipts.length) {
      if (backlog) await scheduleCustomer(ctx, customerRef);
      return null;
    }
    // The generation is the lease token: a crashed worker's later commit fails assertBillingFence.
    const generation = customer.generation + 1;
    await ctx.db.patch("billingCustomers", customerRef, { generation, leaseExpiresAt: now + LEASE_MS });
    return { mode: customer.mode, generation, inputRevision: customer.inputRevision, customerId: customer.customerId ?? null, receipts };
  },
});

export const releaseCustomer = internalMutation({
  args: { customerRef: v.id("billingCustomers"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { customerRef, generation }) => {
    const customer = await ctx.db.get("billingCustomers", customerRef);
    // A stale worker never clears a newer lease; that lease's own release reschedules.
    if (!customer || customer.generation !== generation) return null;
    await ctx.db.patch("billingCustomers", customerRef, { leaseExpiresAt: undefined });
    const next = await pendingReceipts(ctx, customerRef).first();
    if (next) await scheduleCustomer(ctx, customerRef, Math.max(0, next.nextAttemptAt - Date.now()));
    return null;
  },
});

export const processCustomer = internalAction({
  args: { customerRef: v.id("billingCustomers") },
  returns: v.null(),
  handler: async (ctx, { customerRef }): Promise<null> => {
    const claim: Claim | null = await ctx.runMutation(internal.billingQueue.claimCustomer, { customerRef });
    if (!claim) return null;
    try {
      await reconcileClaim(ctx, customerRef, claim);
    } catch (error) {
      // Codes only: provider errors may echo bodies, ids of other parties or env.
      const code = error instanceof ConvexError ? (error.data as { code?: string }).code : undefined;
      console.error("[billingQueue] reconcile failed", { customerRef, generation: claim.generation, code: code ?? "UNKNOWN" });
    } finally {
      await ctx.runMutation(internal.billingQueue.releaseCustomer, { customerRef, generation: claim.generation });
    }
    return null;
  },
});

// Cron: recovers lost scheduled actions and crashed leases. The range stays fixed (only
// `state`) so the cursor is valid across pages; rows past `now` end the sweep.
export const sweepReceipts = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const { page, isDone, continueCursor } = await ctx.db.query("billingEvents")
      .withIndex("by_state_and_nextAttemptAt", q => q.eq("state", "pending"))
      .paginate({ cursor: cursor ?? null, numItems: MAX_SWEEP_RECEIPTS });
    const due = page.filter(receipt => receipt.nextAttemptAt <= now);
    for (const customerRef of new Set(due.flatMap(receipt => receipt.customerRef ?? []))) {
      const customer = await ctx.db.get("billingCustomers", customerRef);
      if (customer && !isLeased(customer, now)) await scheduleCustomer(ctx, customerRef);
    }
    if (!isDone && due.length === page.length) {
      console.error("[billingQueue] sweep backlog", { scanned: page.length });
      await ctx.scheduler.runAfter(0, internal.billingQueue.sweepReceipts, { cursor: continueCursor });
    }
    return null;
  },
});

// Operator only (`npx convex run billingQueue:redriveReceipt`); production needs explicit approval.
export const redriveReceipt = internalMutation({
  args: { eventRef: v.id("billingEvents") },
  returns: v.null(),
  handler: async (ctx, { eventRef }) => {
    const receipt = await ctx.db.get("billingEvents", eventRef);
    if (!receipt) throw appError("NOT_FOUND", "Billing receipt not found");
    if (receipt.state !== "quarantined" || !receipt.customerRef) {
      throw appError("INVALID_ARGUMENT", "Only a mapped quarantined receipt can be redriven");
    }
    const customer = await ctx.db.get("billingCustomers", receipt.customerRef);
    if (!customer) throw appError("NOT_FOUND", "Billing customer not found");
    // unresolvedReceipts is unchanged: the receipt was already counted while quarantined.
    await ctx.db.patch("billingEvents", eventRef, { state: "pending", attempts: 0, nextAttemptAt: Date.now(), quarantineReason: undefined });
    await ctx.db.patch("billingCustomers", customer._id, { inputRevision: customer.inputRevision + 1 });
    await scheduleCustomer(ctx, customer._id);
    return null;
  },
});

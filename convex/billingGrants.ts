import { v, type Infer } from "convex/values";

import { allocateCredits, type GrantKind, lotUnspent, rolloverQuantity } from "../src/features/billing/grants";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { appError } from "./errors";
import { billingGrantKindValidator, billingModeValidator } from "./schema";

/**
 * Paid credit lots (ADR 0016). Plain helpers, not registered functions: the
 * fulfillment and charge mutations call them so every grant and spend commits
 * in the same transaction as its fence check or usage row.
 */

/**
 * Most unexpired lots of a kind one user can hold. A renewal settled before the
 * period ends briefly leaves two period (and rollover) lots; checkout refuses a
 * top-up at the cap, but an already-settled payment is still granted.
 */
export const MAX_ACTIVE_LOTS: Record<GrantKind, number> = { current_period: 2, rollover: 2, top_up: 100 };

export const grantTermsValidator = v.object({
  mode: billingModeValidator,
  sourceKey: v.string(),
  customerRef: v.id("billingCustomers"),
  purchaseRef: v.optional(v.id("billingPurchases")),
  kind: billingGrantKindValidator,
  quantity: v.number(),
  expiresAt: v.number(),
  serviceStart: v.optional(v.number()),
  serviceEnd: v.optional(v.number()),
  sourceGrantRef: v.optional(v.id("billingGrants")),
});
type GrantTerms = Infer<typeof grantTermsValidator>;
const TERM_FIELDS = Object.keys(grantTermsValidator.fields) as (keyof GrantTerms)[];

const validTerms = ({ sourceKey, kind, quantity, expiresAt, serviceStart, serviceEnd, sourceGrantRef }: GrantTerms) =>
  sourceKey.trim() !== "" &&
  (sourceGrantRef === undefined || kind === "rollover") &&
  Number.isSafeInteger(quantity) &&
  quantity > 0 &&
  Number.isFinite(expiresAt) &&
  (serviceStart === undefined
    ? serviceEnd === undefined && kind !== "current_period"
    : serviceEnd !== undefined && Number.isFinite(serviceStart) && serviceStart < serviceEnd);

type Grant = Doc<"billingGrants">;
type Mode = Grant["mode"];

/** Marks a lot whose write leaves nothing unspent, so it leaves the active-lot index. */
const exhaustedIf = (lot: Parameters<typeof lotUnspent>[0]) => (lotUnspent(lot) === 0 ? { exhausted: true as const } : {});

/**
 * Inserts a grant once per (mode, sourceKey): a replay with the same terms
 * returns the original row, and different terms for the key conflict. The
 * indexed check and insert share the caller's transaction. A new settled grant
 * (period or top-up, never a rollover) first pays off the account's debt, but
 * only when the account is billing-enabled in the grant's mode, since that
 * mode's charges recorded the debt.
 */
export async function insertGrant(ctx: MutationCtx, terms: GrantTerms): Promise<Id<"billingGrants">> {
  if (!validTerms(terms)) throw appError("INVALID_ARGUMENT", "Invalid billing grant terms");
  const customer = await ctx.db.get("billingCustomers", terms.customerRef);
  if (!customer) throw appError("NOT_FOUND", "Billing customer not found");
  const conflict = () => appError("CONFLICT", "Billing grant conflicts with durable state");
  if (customer.mode !== terms.mode) throw conflict();
  const existing = await ctx.db
    .query("billingGrants")
    .withIndex("by_mode_and_sourceKey", (q) => q.eq("mode", terms.mode).eq("sourceKey", terms.sourceKey))
    .unique();
  if (existing) {
    if (TERM_FIELDS.some((field) => existing[field] !== terms[field])) throw conflict();
    return existing._id;
  }
  const lot = { ...terms, userId: customer.userId, consumed: 0, revoked: 0 };
  if (terms.kind === "rollover") return await ctx.db.insert("billingGrants", lot);
  const account = await ctx.db
    .query("creditAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", customer.userId))
    .unique();
  const debt = account?.paidCreditsVersion !== undefined && account.paidCreditsMode === terms.mode ? (account.creditDebt ?? 0) : 0;
  const debtOffset = Math.min(debt, terms.quantity);
  if (!account || debtOffset === 0) return await ctx.db.insert("billingGrants", lot);
  await ctx.db.patch("creditAccounts", account._id, { creditDebt: debt - debtOffset });
  return await ctx.db.insert("billingGrants", { ...lot, debtOffset, ...exhaustedIf({ ...lot, debtOffset }) });
}

/** The user's unexpired, unexhausted `mode` lots of `kind`: what spending reads and checkout counts. */
const activeLotsQuery = (ctx: MutationCtx, userId: string, mode: Mode, kind: GrantKind, now: number) =>
  ctx.db
    .query("billingGrants")
    .withIndex("by_userId_and_mode_and_kind_and_exhausted_and_expiresAt", (q) =>
      q.eq("userId", userId).eq("mode", mode).eq("kind", kind).eq("exhausted", undefined).gt("expiresAt", now),
    );

/** How many active `kind` lots the user holds, read up to the kind's cap (checkout refuses at the cap). */
export const countActiveLots = async (ctx: MutationCtx, userId: string, mode: Mode, kind: GrantKind, now: number) =>
  (await activeLotsQuery(ctx, userId, mode, kind, now).take(MAX_ACTIVE_LOTS[kind])).length;

/**
 * The user's unexpired, unexhausted `mode` lots, at most cap + 1 per kind in
 * spending order. Lots past a cap expire no earlier than those read, so the
 * walk stops at the first capped kind: no later kind is spent while it may
 * hold unread credits.
 */
export async function readActiveLots(ctx: QueryCtx, userId: string, mode: Mode, now: number) {
  const lots: Grant[] = [];
  for (const kind of Object.keys(MAX_ACTIVE_LOTS) as GrantKind[]) {
    const cap = MAX_ACTIVE_LOTS[kind];
    const rows = await activeLotsQuery(ctx, userId, mode, kind, now).take(cap + 1);
    lots.push(...rows.slice(0, cap));
    if (rows.length > cap) return { lots, capped: kind };
  }
  return { lots, capped: undefined };
}

/**
 * Spends `credits` of new usage on `userId`'s unexpired `mode` lots and returns
 * the shortfall, which the caller records as debt. Past a cap the remainder
 * becomes debt, logged so support can consolidate the lots and reverse it.
 * Never throws for overflow: that would roll back the usage row, and callers
 * ignore a failed charge.
 */
export async function spendPaidCredits(ctx: MutationCtx, userId: string, mode: Mode, credits: number, now: number) {
  if (credits <= 0) return 0;
  const { lots, capped } = await readActiveLots(ctx, userId, mode, now);
  const { takes, shortfall } = allocateCredits(lots, credits, now);
  if (capped && shortfall > 0) {
    console.warn(`Paid credit lots over cap: userId=${userId} mode=${mode} kind=${capped}; ${shortfall} credits recorded as debt`);
  }
  for (const { lot, credits: taken } of takes) {
    const consumed = lot.consumed + taken;
    await ctx.db.patch("billingGrants", lot._id, { consumed, ...exhaustedIf({ ...lot, consumed }) });
  }
  return shortfall;
}

/**
 * The user's unexpired `mode` period lots, spent ones included, for
 * `isInPaidPeriod`. Period lots expire in order, so the live one is in the read.
 */
export const readPeriodLots = (ctx: QueryCtx, userId: string, mode: Mode, now: number) =>
  ctx.db
    .query("billingGrants")
    .withIndex("by_userId_and_mode_and_kind_and_expiresAt", (q) =>
      q.eq("userId", userId).eq("mode", mode).eq("kind", "current_period").gt("expiresAt", now),
    )
    .take(MAX_ACTIVE_LOTS.current_period + 1);

/**
 * Carries the unspent credits of the period lot that ended where `nextRef`
 * starts into one rollover lot, capped at ROLLOVER_CAP and expiring with
 * `nextRef`. Renewal fulfillment calls it right after inserting the new period
 * grant. Idempotent: a replay returns the same rollover. Never revives credit
 * that is already past: nothing rolls into a period that has ended, or from a
 * source granted after its own end (both mean a missed period applied late).
 * Null when nothing rolls over.
 */
export async function rollOverIntoPeriod(ctx: MutationCtx, nextRef: Id<"billingGrants">, now: number) {
  const next = await ctx.db.get("billingGrants", nextRef);
  if (next?.kind !== "current_period" || next.serviceStart === undefined || next.serviceEnd === undefined) {
    throw appError("INVALID_ARGUMENT", "Rollover target must be a period grant");
  }
  if (next.serviceEnd <= now) return null;
  const candidates = await ctx.db
    .query("billingGrants")
    .withIndex("by_userId_and_mode_and_kind_and_expiresAt", (q) =>
      q.eq("userId", next.userId).eq("mode", next.mode).eq("kind", "current_period").eq("expiresAt", next.serviceStart!),
    )
    .take(MAX_ACTIVE_LOTS.current_period + 1);
  const source = candidates.find(
    (lot) => lot._id !== next._id && lot.customerRef === next.customerRef && lot.serviceEnd === next.serviceStart,
  );
  if (!source) return null;
  const sourceKey = `rollover:${source.sourceKey}`;
  const existing = await ctx.db
    .query("billingGrants")
    .withIndex("by_mode_and_sourceKey", (q) => q.eq("mode", next.mode).eq("sourceKey", sourceKey))
    .unique();
  if (existing) return existing._id;
  const quantity = rolloverQuantity(source);
  if (source._creationTime >= source.expiresAt || quantity <= 0) return null;
  const rollover = await insertGrant(ctx, {
    mode: next.mode,
    sourceKey,
    customerRef: source.customerRef,
    purchaseRef: source.purchaseRef,
    kind: "rollover",
    quantity,
    expiresAt: next.serviceEnd,
    sourceGrantRef: source._id,
  });
  const transferred = (source.transferred ?? 0) + quantity;
  await ctx.db.patch("billingGrants", source._id, { transferred, ...exhaustedIf({ ...source, transferred }) });
  return rollover;
}

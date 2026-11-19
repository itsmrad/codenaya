import { v, type Infer } from "convex/values";

import { allocateCredits, type GrantKind } from "../src/features/billing/grants";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
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
});
type GrantTerms = Infer<typeof grantTermsValidator>;
const TERM_FIELDS = Object.keys(grantTermsValidator.fields) as (keyof GrantTerms)[];

const validTerms = ({ sourceKey, kind, quantity, expiresAt, serviceStart, serviceEnd }: GrantTerms) =>
  sourceKey.trim() !== "" &&
  Number.isSafeInteger(quantity) &&
  quantity > 0 &&
  Number.isFinite(expiresAt) &&
  (serviceStart === undefined
    ? serviceEnd === undefined && kind !== "current_period"
    : serviceEnd !== undefined && Number.isFinite(serviceStart) && serviceStart < serviceEnd);

/**
 * Inserts a grant once per (mode, sourceKey): a replay with the same terms
 * returns the original row, and different terms for the key conflict. The
 * indexed check and insert share the caller's transaction.
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
  return await ctx.db.insert("billingGrants", { ...terms, userId: customer.userId, consumed: 0, revoked: 0 });
}

/**
 * Spends `credits` of new usage on `userId`'s unexpired `mode` lots and returns
 * the shortfall, which the caller records as debt. Reads at most cap + 1 lots
 * per kind, in spending order. Lots past a cap expire no earlier than those
 * read, so a capped kind spends its read lots and stops there: no later kind is
 * spent while it may hold unread credits. What remains becomes debt, logged so
 * support can consolidate the lots and reverse it. Never throws for overflow:
 * that would roll back the usage row, and callers ignore a failed charge.
 */
export async function spendPaidCredits(
  ctx: MutationCtx,
  userId: string,
  mode: Doc<"billingGrants">["mode"],
  credits: number,
  now: number,
) {
  const lots: Doc<"billingGrants">[] = [];
  let capped: GrantKind | undefined;
  for (const kind of Object.keys(MAX_ACTIVE_LOTS) as GrantKind[]) {
    const cap = MAX_ACTIVE_LOTS[kind];
    const rows = await ctx.db
      .query("billingGrants")
      .withIndex("by_userId_and_mode_and_kind_and_expiresAt", (q) =>
        q.eq("userId", userId).eq("mode", mode).eq("kind", kind).gt("expiresAt", now),
      )
      .take(cap + 1);
    lots.push(...rows.slice(0, cap));
    if (rows.length > cap) {
      capped = kind;
      break;
    }
  }
  const { takes, shortfall } = allocateCredits(lots, credits, now);
  if (capped && shortfall > 0) {
    console.warn(`Paid credit lots over cap: userId=${userId} mode=${mode} kind=${capped}; ${shortfall} credits recorded as debt`);
  }
  for (const take of takes) {
    await ctx.db.patch("billingGrants", take.lot._id, { consumed: take.lot.consumed + take.credits });
  }
  return shortfall;
}

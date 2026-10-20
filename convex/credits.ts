import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import {
  CREDIT_PERIOD_MS,
  DAILY_PERIOD_MS,
  PLANS,
  TOP_UP,
  creditsForUsageUsd,
} from "../src/features/billing/plans";

/**
 * Credits and billing (#105).
 *
 * A platform run costs `ceil(cost_usd × 1.5 × 100)` credits; BYOK runs cost
 * nothing but still write a ledger row so usage analytics see them. The
 * balance is one row per user (`creditAccounts`), created and rolled over
 * lazily by `getOrInitAccount` — there is no cron, so an idle account costs
 * nothing.
 *
 * All balance changes happen in the same mutation as their ledger row, so the
 * two can never disagree.
 */

/** Most ledger rows the billing page shows. */
export const MAX_LEDGER_ROWS = 50;

export const OUT_OF_CREDITS_MESSAGE =
  "You're out of credits. Upgrade to Pro, buy a top-up, or add your own API key to keep building.";

/** How the billing page and navbar read the account. */
export interface AccountView {
  plan: Doc<"creditAccounts">["plan"];
  balance: number;
  topupBalance: number;
  dailyUsed: number;
  dailyCap: number | null;
  periodEndsAt: number | null;
  cancelAtPeriodEnd: boolean;
}

const accountByUserId = (ctx: QueryCtx | MutationCtx, userId: string) =>
  ctx.db
    .query("creditAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

/** Read-only view, defaulting to a fresh Free account before the row exists. */
export async function readAccountView(
  ctx: QueryCtx,
  userId: string,
): Promise<AccountView> {
  const account = await accountByUserId(ctx, userId);
  const plan = PLANS[account?.plan ?? "free"];
  return {
    plan: account?.plan ?? "free",
    balance: account?.balance ?? plan.monthlyCredits,
    topupBalance: account?.topupBalance ?? 0,
    dailyUsed: account?.dailyUsed ?? 0,
    dailyCap: plan.dailyCreditCap,
    periodEndsAt: account?.periodEndsAt ?? null,
    cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
  };
}

/**
 * Creates the Free account on first use, or rolls an expired period/day over.
 * Pro keeps one month of unused credits (`balance + grant`, capped at two
 * grants); Free starts each period from its grant again.
 */
export async function getOrInitAccount(
  ctx: MutationCtx,
  userId: string,
  now = Date.now(),
): Promise<Doc<"creditAccounts">> {
  const existing = await accountByUserId(ctx, userId);
  if (!existing) {
    const plan = PLANS.free;
    const id = await ctx.db.insert("creditAccounts", {
      userId,
      plan: "free",
      balance: plan.monthlyCredits,
      dailyUsed: 0,
      dailyResetAt: now + DAILY_PERIOD_MS,
      periodGrant: plan.monthlyCredits,
      periodEndsAt: now + CREDIT_PERIOD_MS,
      topupBalance: 0,
      updatedAt: now,
    });
    return (await ctx.db.get("creditAccounts", id))!;
  }

  let { plan, balance, periodGrant, periodEndsAt, dailyUsed, dailyResetAt } =
    existing;
  let changed = false;

  if (periodEndsAt <= now) {
    // A canceled subscription drops to Free when the paid period ends.
    plan = existing.cancelAtPeriodEnd ? "free" : plan;
    const grant = PLANS[plan].monthlyCredits;
    balance = plan === "pro" ? Math.min(balance + grant, grant * 2) : grant;
    periodGrant = grant;
    periodEndsAt = now + CREDIT_PERIOD_MS;
    changed = true;
  }

  if (dailyResetAt <= now) {
    dailyUsed = 0;
    dailyResetAt = now + DAILY_PERIOD_MS;
    changed = true;
  }

  if (!changed) return existing;

  await ctx.db.patch("creditAccounts", existing._id, {
    plan,
    balance,
    periodGrant,
    periodEndsAt,
    dailyUsed,
    dailyResetAt,
    // Clear the flag once it has been applied.
    ...(existing.cancelAtPeriodEnd ? { cancelAtPeriodEnd: undefined } : {}),
    updatedAt: now,
  });
  return (await ctx.db.get("creditAccounts", existing._id))!;
}

/**
 * Pre-run gate. BYOK runs are unlimited and skip every check (and the account
 * is not created for them). Throws a typed `INSUFFICIENT_CREDITS` when the
 * account has no credits left, or has used the Free plan's daily allowance.
 */
export async function assertCanRunForUser(
  ctx: MutationCtx,
  {
    userId,
    byok,
    now = Date.now(),
  }: { userId: string; byok: boolean; now?: number },
): Promise<AccountView & { skipped: boolean }> {
  if (byok) {
    // No account is created for a BYOK-only user; the plan still matters to
    // the caller (a Free account may not pick a paid platform model).
    return { ...(await readAccountView(ctx, userId)), skipped: true };
  }

  const account = await getOrInitAccount(ctx, userId, now);
  const plan = PLANS[account.plan];

  if (account.balance + account.topupBalance <= 0) {
    throw appError("INSUFFICIENT_CREDITS", OUT_OF_CREDITS_MESSAGE, {
      reason: "out_of_credits",
    });
  }

  if (plan.dailyCreditCap !== null && account.dailyUsed >= plan.dailyCreditCap) {
    throw appError(
      "INSUFFICIENT_CREDITS",
      `You've used today's ${plan.dailyCreditCap} Free credits. Upgrade to Pro, buy a top-up, or add your own API key to keep building.`,
      { reason: "daily_limit" },
    );
  }

  return { ...(await readAccountView(ctx, userId)), skipped: false };
}

export interface ChargeRunArgs {
  userId: string;
  messageId: Id<"messages">;
  byok: boolean;
  model?: string;
  costUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  now?: number;
}

/**
 * Post-run charge, idempotent on `messageId`: an Inngest replay finds the row
 * from the first attempt and returns it instead of charging twice. Spends the
 * monthly grant before top-ups, and clamps at zero (a run may overspend its
 * last credits). BYOK writes a zero row for analytics.
 */
export async function chargeRunForUser(
  ctx: MutationCtx,
  args: ChargeRunArgs,
): Promise<{ charged: number; byok: boolean; duplicate: boolean }> {
  const existing = await ctx.db
    .query("creditLedger")
    .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
    .first();

  if (existing) {
    return { charged: -existing.delta, byok: existing.byok, duplicate: true };
  }

  const now = args.now ?? Date.now();
  const base = {
    userId: args.userId,
    kind: "usage" as const,
    messageId: args.messageId,
    ...(args.model ? { model: args.model } : {}),
    costUsd: args.costUsd,
    ...(args.promptTokens !== undefined
      ? { promptTokens: args.promptTokens }
      : {}),
    ...(args.completionTokens !== undefined
      ? { completionTokens: args.completionTokens }
      : {}),
    createdAt: now,
  };

  if (args.byok) {
    await ctx.db.insert("creditLedger", { ...base, delta: 0, byok: true });
    return { charged: 0, byok: true, duplicate: false };
  }

  const credits = creditsForUsageUsd(args.costUsd);
  const account = await getOrInitAccount(ctx, args.userId, now);
  const fromGrant = Math.min(account.balance, credits);
  const fromTopup = Math.min(account.topupBalance, credits - fromGrant);

  await ctx.db.patch("creditAccounts", account._id, {
    balance: account.balance - fromGrant,
    topupBalance: account.topupBalance - fromTopup,
    dailyUsed: account.dailyUsed + credits,
    updatedAt: now,
  });
  await ctx.db.insert("creditLedger", { ...base, delta: -credits, byok: false });

  return { charged: credits, byok: false, duplicate: false };
}

/** Normalised Polar webhook event, parsed by `convex/http.ts`. */
export const polarEventKindValidator = v.union(
  v.literal("subscription_active"),
  v.literal("subscription_canceled"),
  v.literal("topup"),
);

/**
 * Applies a verified Polar webhook, idempotent on `externalId` (the invoice,
 * order or subscription-period id). Polar retries on any non-2xx, so a replayed
 * event must grant nothing.
 */
export const applyPolarEvent = internalMutation({
  args: {
    kind: polarEventKindValidator,
    userId: v.string(),
    externalId: v.string(),
    /** Subscription period end from the payload, if it had one. */
    periodEndsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const alreadyApplied = await ctx.db
      .query("creditLedger")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (alreadyApplied) {
      return { applied: false, plan: null };
    }

    const now = Date.now();
    const account = await getOrInitAccount(ctx, args.userId, now);

    if (args.kind === "subscription_canceled") {
      // Keep Pro until the paid period ends; the lazy reset downgrades then.
      await ctx.db.patch("creditAccounts", account._id, {
        cancelAtPeriodEnd: true,
        updatedAt: now,
      });
      return { applied: true, plan: account.plan };
    }

    if (args.kind === "topup") {
      if (account.plan !== "pro") {
        throw appError(
          "CONFLICT",
          "Top-ups are only available on the Pro plan.",
        );
      }
      await ctx.db.patch("creditAccounts", account._id, {
        topupBalance: account.topupBalance + TOP_UP.credits,
        updatedAt: now,
      });
      await ctx.db.insert("creditLedger", {
        userId: args.userId,
        delta: TOP_UP.credits,
        kind: "topup",
        byok: false,
        externalId: args.externalId,
        createdAt: now,
      });
      return { applied: true, plan: account.plan };
    }

    // subscription.active / renewed: Pro plus a fresh monthly grant. An
    // upgrade replaces the Free grant; a renewal adds to it (1-month rollover).
    const grant = PLANS.pro.monthlyCredits;
    const balance =
      account.plan === "pro"
        ? Math.min(account.balance + grant, grant * 2)
        : grant;
    await ctx.db.patch("creditAccounts", account._id, {
      plan: "pro",
      balance,
      periodGrant: grant,
      periodEndsAt: args.periodEndsAt ?? now + CREDIT_PERIOD_MS,
      cancelAtPeriodEnd: undefined,
      updatedAt: now,
    });
    await ctx.db.insert("creditLedger", {
      userId: args.userId,
      delta: grant,
      kind: "grant",
      byok: false,
      externalId: args.externalId,
      createdAt: now,
    });
    return { applied: true, plan: "pro" };
  },
});

/**
 * Creates the row on first use. Exposed for tests and for any future
 * server-side warm-up; the real lazy path is `assertCanRun`.
 */
export const getOrInitAccountForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const account = await getOrInitAccount(ctx, args.userId);
    return await readAccountView(ctx, args.userId);
  },
});

/** The signed-in user's plan and balance, for the navbar pill and billing page. */
export const account = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    return await readAccountView(ctx, identity.subject);
  },
});

/** The signed-in user's recent credit movements, newest first. */
export const ledger = query({
  args: {},
  handler: async (ctx) => {
    const identity = await verifyAuth(ctx);
    const rows = await ctx.db
      .query("creditLedger")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(MAX_LEDGER_ROWS);

    return rows.map((row) => ({
      id: row._id,
      delta: row.delta,
      kind: row.kind,
      model: row.model ?? null,
      costUsd: row.costUsd ?? null,
      byok: row.byok,
      createdAt: row.createdAt,
    }));
  },
});

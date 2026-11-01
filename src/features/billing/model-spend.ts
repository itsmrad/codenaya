/**
 * Per-model spend limits (ADR 0012): the admin caps what one model may cost,
 * in USD at its catalog price, per user and across the whole site, over a
 * period that resets daily, weekly (Monday, UTC), monthly or never. Pure on
 * purpose: Convex records spend with it and the send routes refuse with it.
 */

export const SPEND_RESETS = ["daily", "weekly", "monthly", "never"] as const;

export type SpendReset = (typeof SPEND_RESETS)[number];

/** A catalog model's limit. At least one cap is set; a missing cap is no cap. */
export interface SpendLimit {
  perUserUsd?: number;
  totalUsd?: number;
  resets: SpendReset;
}

/** The highest cap the admin may set, so a typo can't mean "unlimited". */
export const MAX_SPEND_LIMIT_USD = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the period holding `now` began (UTC); 0 for a limit that never resets. */
export function spendPeriodStart(resets: SpendReset, now: number): number {
  const date = new Date(now);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  switch (resets) {
    case "daily":
      return day;
    case "weekly":
      // getUTCDay: Sunday 0. Weeks start on Monday.
      return day - ((date.getUTCDay() + 6) % 7) * DAY_MS;
    case "monthly":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    case "never":
      return 0;
  }
}

/** A spend row as stored: what was spent since `periodStartsAt`. */
export interface SpendRow {
  periodStartsAt: number;
  spentUsd: number;
}

/** What `row` spent in the current period: a row from an earlier period spent nothing in it. */
export const spentInPeriod = (row: SpendRow | null, periodStartsAt: number) =>
  row && row.periodStartsAt === periodStartsAt ? row.spentUsd : 0;

export type SpendRefusal = "user_limit" | "total_limit";

/** Which cap a send on the model would pass, or null when both have room. */
export function spendRefusal(
  limit: SpendLimit,
  spent: { user: SpendRow | null; total: SpendRow | null },
  now: number,
): SpendRefusal | null {
  const start = spendPeriodStart(limit.resets, now);
  if (limit.totalUsd !== undefined && spentInPeriod(spent.total, start) >= limit.totalUsd) return "total_limit";
  if (limit.perUserUsd !== undefined && spentInPeriod(spent.user, start) >= limit.perUserUsd) return "user_limit";
  return null;
}

const PERIOD_WORDS: Record<SpendReset, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
  never: "for now",
};

export const spendRefusalMessage = (refusal: SpendRefusal, modelName: string, resets: SpendReset) =>
  refusal === "user_limit"
    ? `You've used your ${modelName} allowance ${PERIOD_WORDS[resets]}. Pick another model to continue.`
    : `${modelName} has reached its usage limit ${PERIOD_WORDS[resets]}. Pick another model to continue.`;

/** The `code` a send route answers when a model's spend limit is reached. */
export const MODEL_LIMIT_CODE = "model_limit_reached";

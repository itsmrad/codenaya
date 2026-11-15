"use client";

import Link from "next/link";

import { useCreditUsage } from "@/features/billing/hooks/use-credit-usage";
import { formatCredits } from "@/features/billing/plans";
import { USAGE_SETTINGS_URL } from "@/features/settings/nav";

/** One line above the composer when under 20% of the day or month is left (#526). */
export const LowCreditsNotice = () => {
  const usage = useCreditUsage();
  if (!usage?.isLow) return null;
  const { day, month } = usage;
  const today = day !== null && day.left <= month.left;
  const left = today ? day.left : month.left;
  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      {left === 0 ? "No" : `Only ${formatCredits(left)}`} {left === 1 ? "credit" : "credits"} left{" "}
      {today ? "today" : "this month"}.{" "}
      <Link href={USAGE_SETTINGS_URL} className="text-foreground underline underline-offset-2">
        See usage
      </Link>
    </p>
  );
};

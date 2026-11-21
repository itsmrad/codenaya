/** Deleted accounts' financial records are retained for 18 calendar months. */
export const BILLING_RECORD_RETENTION_MONTHS = 18;

/** UTC calendar arithmetic, preserving time of day and clamping to the month's last day. */
export function billingRetentionEndsAt(deletedAt: number): number {
  const at = new Date(deletedAt);
  const month = at.getUTCMonth() + BILLING_RECORD_RETENTION_MONTHS;
  const year = at.getUTCFullYear() + Math.floor(month / 12);
  const targetMonth = month % 12;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  at.setUTCFullYear(year, targetMonth, Math.min(at.getUTCDate(), lastDay));
  return at.getTime();
}

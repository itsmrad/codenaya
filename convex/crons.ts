import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * Scheduled maintenance.
 *
 * ## Why the intervals differ
 *
 * Each job is paced to how fast its table actually grows, because every cron run
 * counts against the Convex free tier's 1,000,000 monthly function calls. Running
 * everything every minute would burn roughly 130,000 calls a month on cleanup alone
 * — a meaningful slice of the budget for work that is not time-sensitive.
 *
 * The ones that matter most for correctness run most often:
 *
 * - **Approvals every 5 minutes.** A lapsed `pending` row has to reach a terminal
 *   status reasonably promptly, since an agent may be polling it.
 * - **Lost agent runs every 5 minutes.** A run that stopped reporting progress
 *   leaves its chat showing "Thinking…" until this marks it failed.
 * - **Billing receipts every 5 minutes.** Recovers lost scheduled actions and crashed
 *   customer leases (`convex/billingQueue.ts`). Payments correctness depends on it:
 *   without it a dropped wakeup leaves a paid receipt unprocessed.
 * - **Billing provider poll every 15 minutes.** Catches missed payment, refund, dispute and
 *   subscription webhooks and releases expired unpaid checkout locks (`convex/billingPoll.ts`).
 *   Bounded per run; only customers with a checkout, a subscription or a reversal watch are due.
 * - **OAuth states every 15 minutes.** Their own TTL is 10 minutes, so this keeps
 *   the table near-empty without being urgent.
 *
 * The rest are pure housekeeping and run hourly or daily.
 *
 * ## Batching interacts with scheduling
 *
 * Each job deletes at most 200 rows per run. If a backlog ever exceeds what the
 * schedule drains, it clears over successive runs rather than failing — which is why
 * a bounded batch was chosen over trying to delete everything at once.
 */
const crons = cronJobs();

crons.interval(
  "prune expired mcp approvals",
  { minutes: 5 },
  internal.maintenance.pruneMcpApprovals,
);

crons.interval(
  "fail lost agent runs",
  { minutes: 5 },
  internal.maintenance.failLostMessageRuns,
);

crons.interval(
  "sweep billing receipts",
  { minutes: 5 },
  internal.billingQueue.sweepReceipts,
  {},
);

crons.interval(
  "poll billing provider state",
  { minutes: 15 },
  internal.billingPoll.selectPollTargets,
  {},
);

crons.interval(
  "prune expired oauth flow states",
  { minutes: 15 },
  internal.maintenance.pruneOauthFlowStates,
);

crons.interval(
  "prune orphaned project connections",
  { hours: 6 },
  internal.maintenance.pruneOrphanedProjectConnections,
  {},
);

crons.interval(
  "prune old mcp audit log entries",
  { hours: 24 },
  internal.maintenance.pruneMcpAuditLog,
);

export default crons;

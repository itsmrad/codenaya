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
 * The two that matter most for correctness run most often:
 *
 * - **Approvals every 5 minutes.** A lapsed `pending` row has to reach a terminal
 *   status reasonably promptly, since an agent may be polling it.
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
  "prune expired oauth flow states",
  { minutes: 15 },
  internal.maintenance.pruneOauthFlowStates,
);

crons.interval(
  "prune orphaned project connections",
  { hours: 6 },
  internal.maintenance.pruneOrphanedProjectConnections,
);

crons.interval(
  "prune old mcp audit log entries",
  { hours: 24 },
  internal.maintenance.pruneMcpAuditLog,
);

export default crons;

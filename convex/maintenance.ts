import { internalMutation } from "./_generated/server";
import {
  LOST_RUN_MESSAGE,
  LOST_RUN_MS,
  lastRunActivity,
} from "../src/features/conversations/agent-steps";

/**
 * Scheduled cleanup for integration tables.
 *
 * ## Why these need pruning
 *
 * Three of the integration tables grow without bound if left alone, and the Convex
 * free tier allows 0.5 GB total including indexes:
 *
 * - `oauthFlowStates` — one row per *attempted* connection. Abandoned flows (user
 *   closes the popup, changes their mind) never get consumed, so they accumulate
 *   faster than successful ones.
 * - `mcpApprovals` — one row per destructive tool call. Resolved rows have no
 *   further use once the agent has read them.
 * - `mcpToolAuditLog` — one row per tool invocation. This is the fastest-growing
 *   table by far; an active project could add hundreds a day.
 *
 * ## Why `internalMutation`
 *
 * These are only reachable from the cron scheduler, not from any client. A public
 * mutation that bulk-deletes rows would be an obvious thing to point at the wrong
 * table.
 *
 * ## Why batched
 *
 * Convex mutations are transactions with execution limits. An unbounded delete over
 * a large table would exceed them and fail *every* run, meaning the table grows
 * forever while the cron appears to be configured. A bounded batch always completes;
 * the next scheduled run picks up where it left off.
 */

/**
 * Rows deleted per run, per table.
 *
 * Comfortably inside a single transaction while still draining faster than realistic
 * write rates.
 */
const BATCH_SIZE = 200;

/**
 * How long a resolved approval is kept.
 *
 * Long enough that a user can still see what they approved in a recent session,
 * short enough that the table stays small.
 */
const RESOLVED_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Audit log retention.
 *
 * Thirty days is enough to investigate "what did the agent do to my database last
 * week", which is the question this log exists to answer. Keeping it forever would
 * consume the storage budget for data nobody reads.
 */
const AUDIT_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete expired OAuth flow states.
 *
 * These hold a sealed PKCE verifier. They are single-use and deleted by the callback
 * on success, so anything still here past its expiry is an abandoned attempt. Not a
 * security risk in itself — the verifier is encrypted and useless without a matching
 * authorization code — but there is no reason to retain it.
 */
export const pruneOauthFlowStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const expired = await ctx.db
      .query("oauthFlowStates")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH_SIZE);

    for (const row of expired) {
      await ctx.db.delete("oauthFlowStates", row._id);
    }

    return { deleted: expired.length };
  },
});

/**
 * Mark lapsed approvals expired, then delete old resolved ones.
 *
 * Two phases because the states mean different things. A `pending` row past its
 * deadline must be *marked* expired rather than deleted: `listPendingApprovals`
 * filters by expiry at read time so the UI already hides it, but the agent polling
 * that row needs to see a terminal status rather than a row that vanished, which it
 * would read as "withdrawn".
 */
export const pruneMcpApprovals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const lapsed = await ctx.db
      .query("mcpApprovals")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH_SIZE);

    let markedExpired = 0;
    let deleted = 0;

    for (const row of lapsed) {
      if (row.status === "pending") {
        await ctx.db.patch("mcpApprovals", row._id, {
          status: "expired" as const,
          resolvedAt: now,
        });
        markedExpired += 1;
        continue;
      }

      // Resolved (or already expired) and old enough to discard.
      const resolvedAt = row.resolvedAt ?? row.expiresAt;
      if (now - resolvedAt > RESOLVED_APPROVAL_TTL_MS) {
        await ctx.db.delete("mcpApprovals", row._id);
        deleted += 1;
      }
    }

    return { markedExpired, deleted };
  },
});

/** Delete audit entries past the retention window. */
export const pruneMcpAuditLog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - AUDIT_LOG_TTL_MS;

    const old = await ctx.db
      .query("mcpToolAuditLog")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(BATCH_SIZE);

    for (const row of old) {
      await ctx.db.delete("mcpToolAuditLog", row._id);
    }

    return { deleted: old.length };
  },
});

/**
 * Remove project connections whose credential no longer exists.
 *
 * `deleteUserConnection` cascades its own links, so this only catches rows orphaned
 * by a partial failure. Left in place they are harmless — `getProjectMcpConnections`
 * skips a link with no connection — but they would accumulate and show up as
 * confusing gaps in the project panel.
 */
export const pruneOrphanedProjectConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const links = await ctx.db.query("projectConnections").take(BATCH_SIZE);

    let deleted = 0;
    for (const link of links) {
      const connection = await ctx.db.get(
        "userConnections",
        link.userConnectionId,
      );
      if (!connection) {
        await ctx.db.delete("projectConnections", link._id);
        deleted += 1;
      }
    }

    return { scanned: links.length, deleted };
  },
});

/**
 * Fail agent runs that stopped reporting progress.
 *
 * A run whose worker died, or that the backend dropped (an Inngest dev server
 * restart, a cancelled function), never writes its reply, so the message would
 * stay `processing` forever: a live "Thinking…" timer on every reload. Once a
 * run has gone `LOST_RUN_MS` without recording a step, it is resolved with
 * `LOST_RUN_MESSAGE`, which re-enables the composer and offers Retry. Steps
 * still marked running are closed as errors so the run block reads as failed.
 *
 * Processing rows are few, and the index orders them oldest first, so a single
 * batch reaches the lost ones.
 */
export const failLostMessageRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const processing = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(BATCH_SIZE);

    let failed = 0;
    for (const message of processing) {
      const steps = message.steps ?? [];
      const lastActivity = lastRunActivity(message._creationTime, steps);
      if (now - lastActivity < LOST_RUN_MS) continue;

      await ctx.db.patch("messages", message._id, {
        content: LOST_RUN_MESSAGE,
        status: "completed" as const,
        completedAt: lastActivity,
        steps: steps.map((step) =>
          step.status === "running"
            ? { ...step, status: "error" as const, error: "Interrupted", endedAt: lastActivity }
            : step,
        ),
      });
      failed += 1;
    }

    return { scanned: processing.length, failed };
  },
});

/**
 * Human-in-the-loop gate for destructive MCP tool calls.
 *
 * ## Why polling rather than a backend signal
 *
 * Inngest offers `step.waitForEvent`, which would be the idiomatic way to suspend
 * a run until a user answers. It is deliberately not used. The gate has to behave
 * identically if the Vercel Workflow backend ever receives MCP tools, and I could
 * not verify an equivalent primitive there. Polling a Convex row works the same in
 * both, needs no event plumbing, and the row is useful independently — it is what
 * the UI renders and what the audit trail references.
 *
 * The cost is real but small: one Convex read every few seconds while a human
 * decides. Reads are cheap and the poll only runs when a destructive tool is
 * actually pending.
 *
 * ## Why the wait is bounded
 *
 * A run that waits forever holds an Inngest function open and, worse, leaves the
 * user staring at a spinner with no explanation. Fifteen minutes is long enough for
 * someone to read a confirmation and decide, short enough that an abandoned tab
 * does not strand a run. On timeout the row is marked expired so the UI stops
 * offering a button that would no longer do anything.
 *
 * ## Failure direction
 *
 * Every unexpected outcome denies the call. A gate that fails open would be worse
 * than no gate at all: it would create the appearance of review while allowing
 * unreviewed mutations against the user's real infrastructure.
 */

import { createHash } from "node:crypto";

import { redactJsonValue } from "./redact";

/** How long a user has to answer before the request lapses. */
export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Poll interval.
 *
 * Deliberately not aggressive: a human is reading a dialog, so sub-second latency
 * buys nothing and multiplies Convex function calls, which are metered on the free
 * plan.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Cap on the argument preview shown in the confirmation dialog.
 *
 * A generated SQL statement can be enormous. The user needs enough to judge the
 * action, not the whole payload.
 */
const MAX_ARGS_PREVIEW_CHARS = 2_000;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRow {
  status: ApprovalStatus;
  expiresAt: number;
}

/**
 * Everything the gate needs, injected so this module stays free of Convex and
 * Inngest imports and can be tested with fakes.
 */
export interface ApprovalTransport {
  /** Create a pending row and return its id. */
  create(request: {
    providerId: string;
    projectConnectionId: string;
    toolName: string;
    argsPreview: string;
    expiresAt: number;
  }): Promise<string>;
  /** Read current state. `null` means the row is gone. */
  read(approvalId: string): Promise<ApprovalRow | null>;
  /** Mark a lapsed request expired so the UI stops offering it. */
  expire(approvalId: string): Promise<void>;
  /** Suspend. Injected so tests do not wait in real time. */
  sleep(ms: number): Promise<void>;
  /** Current time, injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Build the human-readable argument summary.
 *
 * Redacted before it is stored, because the row is read by the browser: arguments
 * can legitimately contain a credential the agent is about to write somewhere, and
 * this row would otherwise become a second, unencrypted copy of it.
 */
export function buildArgsPreview(
  args: Record<string, unknown>,
  knownSecrets: readonly string[] = [],
): string {
  const redacted = redactJsonValue(args, knownSecrets);

  let text: string;
  try {
    text = JSON.stringify(redacted.value, null, 2) ?? "{}";
  } catch {
    // Circular or otherwise unserialisable arguments must not break the gate;
    // failing here would deny a legitimate call.
    text = "(arguments could not be displayed)";
  }

  if (text.length <= MAX_ARGS_PREVIEW_CHARS) return text;

  return (
    text.slice(0, MAX_ARGS_PREVIEW_CHARS) +
    `\n… truncated (${text.length - MAX_ARGS_PREVIEW_CHARS} more characters)`
  );
}

/**
 * Stable digest of tool arguments for the audit log.
 *
 * The log records *that* a call happened with particular arguments without storing
 * the arguments, so it cannot become a secondary store of whatever they contained.
 */
export function digestArgs(args: Record<string, unknown>): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(args) ?? "";
  } catch {
    serialised = "(unserialisable)";
  }
  return createHash("sha256").update(serialised).digest("hex").slice(0, 16);
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /** Present when a row was created, for audit correlation. */
  approvalId?: string;
}

export interface RequestApprovalOptions {
  transport: ApprovalTransport;
  providerId: string;
  projectConnectionId: string;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * Shown in the confirmation dialog. Not used to build the refusal text here —
   * the caller does that via `refusalMessage`, so wording stays in one place.
   */
  displayName: string;
  knownSecrets?: readonly string[];
  timeoutMs?: number;
}

/**
 * Ask the user to approve one destructive tool call, and wait for the answer.
 *
 * Resolves rather than throws in every case, so a gate failure surfaces to the
 * model as a refusal it can explain rather than as a crashed run.
 */
export async function requestApproval(
  options: RequestApprovalOptions,
): Promise<ApprovalDecision> {
  const {
    transport,
    providerId,
    projectConnectionId,
    toolName,
    args,
    knownSecrets = [],
    timeoutMs = APPROVAL_TIMEOUT_MS,
  } = options;

  const now = transport.now ?? Date.now;
  const deadline = now() + timeoutMs;

  let approvalId: string;
  try {
    approvalId = await transport.create({
      providerId,
      projectConnectionId,
      toolName,
      argsPreview: buildArgsPreview(args, knownSecrets),
      expiresAt: deadline,
    });
  } catch (error) {
    // Cannot ask, so cannot proceed. Denying is the only safe direction.
    console.error("[mcp/approval] could not create approval request", error);
    return {
      approved: false,
      reason:
        "the approval request could not be created, so this action was not performed",
    };
  }

  while (now() < deadline) {
    await transport.sleep(POLL_INTERVAL_MS);

    let row: ApprovalRow | null;
    try {
      row = await transport.read(approvalId);
    } catch (error) {
      // A transient read failure should not deny outright — the user may already
      // have approved. Keep polling until the deadline.
      console.warn("[mcp/approval] approval read failed, retrying", error);
      continue;
    }

    if (!row) {
      // Deleted mid-flight: treat as withdrawn rather than assuming consent.
      return {
        approved: false,
        approvalId,
        reason: "the approval request was withdrawn",
      };
    }

    if (row.status === "approved") {
      return { approved: true, approvalId };
    }

    if (row.status === "denied") {
      return { approved: false, approvalId, reason: "the user declined" };
    }

    if (row.status === "expired") {
      return {
        approved: false,
        approvalId,
        reason: "the approval request expired",
      };
    }
  }

  // Timed out. Recording the expiry matters: otherwise the UI keeps showing an
  // Approve button for a run that has already stopped waiting, and clicking it
  // would leave the user believing the action ran.
  try {
    await transport.expire(approvalId);
  } catch (error) {
    console.warn("[mcp/approval] could not mark request expired", error);
  }

  return {
    approved: false,
    approvalId,
    reason: `no answer within ${Math.round(timeoutMs / 60_000)} minutes`,
  };
}

/**
 * Message returned to the model when a destructive call is refused.
 *
 * Two things it must achieve: stop the model retrying in a loop, and get the user
 * a useful explanation. Without the explicit "do not retry", models commonly
 * interpret a refusal as a transient error and immediately call the tool again.
 */
export function refusalMessage(
  displayName: string,
  toolName: string,
  reason: string,
): string {
  return (
    `Not permitted: "${toolName}" on ${displayName} was not run because ${reason}. ` +
    `Do NOT retry this tool. Tell the user what you were trying to do and ask how ` +
    `they would like to proceed.`
  );
}

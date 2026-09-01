"use client";

import React from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  ClockIcon,
  LoaderIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import { getProvider } from "../catalog";
import {
  usePendingApprovals,
  useResolveApproval,
} from "../hooks/use-integrations";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * In-chat approval gate for destructive MCP tool calls.
 *
 * ## Why this sits in the transcript
 *
 * When the agent reaches a destructive tool it writes a `pending` row and then
 * blocks inside a durable step, polling that row for up to 15 minutes. If
 * nobody answers, the call is refused. So this prompt is not a nicety — it is
 * the only path by which an approved call ever runs, and it has to be visible
 * exactly while the user is sitting there waiting on the agent.
 *
 * ## Why the countdown is load-bearing
 *
 * The agent stops waiting at `expiresAt`. A button that still looks live after
 * that moment is worse than no button: the user would click Approve, get an
 * error (or worse, believe the action ran) after the agent had already given
 * up. The countdown therefore drives the controls, not just the copy — at zero
 * the actions are withdrawn and replaced with a plain expiry notice.
 *
 * `listPendingApprovals` also drops expired rows server-side at read time, but
 * that only takes effect on the next query invalidation. The local clock is
 * what makes the withdrawal immediate.
 */

/**
 * Derived from the hook rather than restated, so a schema change surfaces here
 * as a type error instead of a silently wrong field.
 */
type PendingApproval = NonNullable<
  ReturnType<typeof usePendingApprovals>
>[number];

/** `m:ss`, floored at zero. */
const formatRemaining = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

interface ApprovalPromptProps {
  projectId: Id<"projects">;
}

export const ApprovalPrompt = ({ projectId }: ApprovalPromptProps) => {
  const approvals = usePendingApprovals(projectId);

  // Lazy initialiser, not an effect: seeding state during render keeps the
  // first paint's countdown correct without tripping set-state-in-effect.
  const [now, setNow] = React.useState<number>(() => Date.now());

  const hasApprovals = (approvals?.length ?? 0) > 0;

  React.useEffect(() => {
    if (!hasApprovals) {
      return;
    }

    // The effect body itself never calls setState — only the interval callback
    // does, which is what `react-hooks/set-state-in-effect` permits.
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [hasApprovals]);

  // Loading (`undefined`) and empty both render nothing. This lives inside a
  // chat transcript, so a skeleton would flash on every query update and read
  // as noise rather than progress.
  if (!approvals || approvals.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {approvals.map((approval) => (
        <ApprovalCard key={approval._id} approval={approval} now={now} />
      ))}
    </div>
  );
};

interface ApprovalCardProps {
  approval: PendingApproval;
  now: number;
}

const ApprovalCard = ({ approval, now }: ApprovalCardProps) => {
  const resolveApproval = useResolveApproval();

  const [decisionInFlight, setDecisionInFlight] = React.useState<
    "approved" | "denied" | null
  >(null);
  const [expiredError, setExpiredError] = React.useState(false);

  const providerName =
    getProvider(approval.providerId)?.displayName ?? approval.providerId;

  const remainingMs = approval.expiresAt - now;
  const isExpired = remainingMs <= 0 || expiredError;
  const isBusy = decisionInFlight !== null;

  const handleDecision = async (decision: "approved" | "denied") => {
    setDecisionInFlight(decision);
    try {
      await resolveApproval({ id: approval._id, decision });
      toast.success(
        decision === "approved"
          ? `Approved ${approval.toolName} — the agent will run it now`
          : `Denied ${approval.toolName}`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.message ? error.message : "";

      // The server patches the row to `expired` and throws when the deadline
      // passed mid-decision. That is a distinct outcome from a failed write and
      // saying "something went wrong" would leave the user retrying a button
      // that can never succeed.
      if (/expired/i.test(message)) {
        setExpiredError(true);
        toast.error(
          "This request expired before it was answered — the agent stopped waiting. Ask again to retry."
        );
      } else if (/already (approved|denied|expired)/i.test(message)) {
        toast.error("This request was already answered.");
      } else {
        toast.error(
          message || "Unable to record your decision. Please try again."
        );
      }
    } finally {
      setDecisionInFlight(null);
    }
  };

  return (
    <div
      role="region"
      aria-label={`Approval required for ${providerName} tool ${approval.toolName}`}
      className={cn(
        "rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-left",
        isExpired && "border-border/60 bg-muted/30"
      )}
    >
      <div className="flex items-start gap-2">
        {isExpired ? (
          <ClockIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
        )}

        <div className="min-w-0 flex-1 space-y-2">
          {/* Static content, so `role="alert"` announces the arrival once
              instead of re-announcing as the countdown ticks. */}
          <div role="alert" className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              {providerName} wants to run{" "}
              <span className="font-mono">{approval.toolName}</span>
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              This runs against your real {providerName} data, outside this
              project. It cannot be undone by editing a file or reverting a
              commit.
            </p>
          </div>

          <pre
            aria-label="Tool arguments"
            tabIndex={0}
            className="max-h-40 overflow-auto rounded-md border border-border/60 bg-background/80 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {approval.argsPreview}
          </pre>

          {isExpired ? (
            // Announced once when it flips, unlike the per-second countdown.
            <p role="status" className="text-[11px] text-muted-foreground">
              This request expired and the agent stopped waiting. Nothing ran.
              Ask again if you still want it.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                {/* Text state, not colour, carries the status. The ticking
                    figure is visual-only; the absolute deadline below is the
                    stable cue screen readers get, so the countdown is never
                    the only signal. */}
                <span>Waiting for your decision</span>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  {" · "}
                </span>
                <span aria-hidden="true" className="font-mono">
                  {formatRemaining(remainingMs)} left
                </span>
                <span className="sr-only">
                  , expires at {format(approval.expiresAt, "HH:mm")}
                </span>
                <span aria-hidden="true">
                  {" "}
                  (expires {format(approval.expiresAt, "HH:mm")})
                </span>
              </p>

              <div className="flex items-center gap-2 pt-0.5">
                {/* Deny leads and carries the calmer weight: refusing is the
                    safe outcome, so it should not require deliberation. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  aria-label={`Deny ${approval.toolName}`}
                  onClick={() => void handleDecision("denied")}
                >
                  {decisionInFlight === "denied" ? (
                    <>
                      <LoaderIcon
                        aria-hidden="true"
                        className="size-3.5 animate-spin"
                      />
                      Denying...
                    </>
                  ) : (
                    "Deny"
                  )}
                </Button>

                {/* Approve is styled as the consequential action, not the
                    happy path — it is the button that mutates real data. */}
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={isBusy}
                  aria-label={`Approve and run ${approval.toolName}`}
                  onClick={() => void handleDecision("approved")}
                >
                  {decisionInFlight === "approved" ? (
                    <>
                      <LoaderIcon
                        aria-hidden="true"
                        className="size-3.5 animate-spin"
                      />
                      Approving...
                    </>
                  ) : (
                    <>
                      <ShieldAlertIcon aria-hidden="true" className="size-3.5" />
                      Approve this run
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

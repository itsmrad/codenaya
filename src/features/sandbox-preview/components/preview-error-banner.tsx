import { useId } from "react";
import { AlertTriangleIcon, SparklesIcon, TerminalSquareIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { AppError } from "../utils/app-error";

/** Fix runs for one error before the banner stops offering another (#223). */
export const MAX_FIX_ATTEMPTS = 2;

/**
 * The app's build or runtime error, laid over the preview with a one-click fix.
 * Error text is the app's own output: it renders as text, never as HTML.
 */
export const PreviewErrorBanner = ({
  error,
  attempts,
  agentWorking,
  chatBlock,
  onFix,
  onShowLogs,
  onDismiss,
}: {
  error: AppError;
  /** Fix runs already sent for this error. */
  attempts: number;
  agentWorking: boolean;
  /** Why the chat can't take a fix yet; see `chatSendBlock`. */
  chatBlock: "sending" | "other-project" | null;
  onFix: () => void;
  onShowLogs: () => void;
  onDismiss: () => void;
}) => {
  // Judged once the last fix run is over, not while it is still working.
  const stillFailing = attempts >= MAX_FIX_ATTEMPTS && !agentWorking;
  const fixBlockedReason =
    chatBlock === "sending"
      ? "Waiting for the chat to send…"
      : chatBlock === "other-project"
        ? "Another project has a message waiting to send"
        : agentWorking
          ? "Available when the agent finishes"
          : null;
  const reasonId = useId();
  const where = error.file ? `${error.file}${error.line ? `:${error.line}` : ""}` : null;

  return (
    <div
      role="alert"
      className="absolute inset-x-3 bottom-3 z-40 flex flex-col gap-2 rounded-xl border border-destructive/40 bg-card/95 p-3 text-xs shadow-lg backdrop-blur-md motion-safe:animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {stillFailing ? "Still failing" : error.kind === "build" ? "Build error" : "Runtime error"}
            {where && <span className="ml-1.5 font-mono font-normal text-muted-foreground">{where}</span>}
          </p>
          <p className="mt-1 line-clamp-3 break-words font-mono text-muted-foreground">
            {error.message}
          </p>
          {stillFailing && (
            <p className="mt-1 text-muted-foreground">
              {MAX_FIX_ATTEMPTS} fixes didn&apos;t clear it. Check the logs, or describe what you see in chat.
            </p>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="-mr-1 -mt-1 size-7 shrink-0 text-muted-foreground"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!stillFailing && fixBlockedReason && (
          <p id={reasonId} className="mr-auto text-muted-foreground">
            {fixBlockedReason}
          </p>
        )}
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onShowLogs}>
          <TerminalSquareIcon className="size-3.5" />
          Show logs
        </Button>
        {!stillFailing && (
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={fixBlockedReason !== null}
            aria-describedby={fixBlockedReason ? reasonId : undefined}
            onClick={onFix}
          >
            <SparklesIcon className="size-3.5" />
            Fix with AI
          </Button>
        )}
      </div>
    </div>
  );
};

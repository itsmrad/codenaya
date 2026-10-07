"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";

import {
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

import type { Doc } from "../../../../convex/_generated/dataModel";
import { sanitizeAgentText } from "../agent-steps";
import { AgentRun } from "./agent-run";

export const UserMessage = ({ content }: { content: string }) => {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [content]);

  return (
    <div className="ml-auto flex max-w-[90%] flex-col items-end @sm:max-w-[85%]">
      <p
        ref={textRef}
        className={cn(
          "rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm/6 whitespace-pre-wrap break-words",
          !expanded && "line-clamp-8",
        )}
      >
        {content}
      </p>
      {clamped && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 mr-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Show more
        </button>
      )}
    </div>
  );
};

interface AssistantMessageProps {
  message: Doc<"messages">;
  /** Last message in the conversation: gets the retry action. */
  isLast: boolean;
  pathOf?: (fileId: string) => string | undefined;
  onOpenFile?: (path: string) => void;
  onRetry?: () => void;
}

export const AssistantMessage = ({
  message,
  isLast,
  pathOf,
  onOpenFile,
  onRetry,
}: AssistantMessageProps) => {
  const [copied, setCopied] = useState(false);
  const status = message.status ?? "completed";
  const steps = message.steps ?? [];
  const content = sanitizeAgentText(message.content, pathOf);

  const copy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/msg flex w-full flex-col gap-3">
      {(status === "processing" || steps.length > 0) && (
        <AgentRun
          steps={steps}
          status={status}
          startedAt={message._creationTime}
          completedAt={message.completedAt}
          onOpenFile={onOpenFile}
        />
      )}
      {status === "cancelled" && steps.length === 0 && (
        <p className="text-sm text-muted-foreground">Request cancelled</p>
      )}
      {status === "completed" && content && (
        <>
          <MessageResponse
            className="chat-prose"
            controls={{ code: { copy: true, download: false } }}
          >
            {content}
          </MessageResponse>
          <MessageActions className="-ml-1.5 -mt-1 opacity-0 transition-opacity duration-100 group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <MessageAction
              size="icon-sm"
              label={copied ? "Copied" : "Copy"}
              tooltip={copied ? "Copied" : "Copy"}
              onClick={copy}
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </MessageAction>
            {isLast && onRetry && (
              <MessageAction
                size="icon-sm"
                label="Retry"
                tooltip="Retry"
                onClick={onRetry}
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <RotateCcwIcon className="size-3.5" />
              </MessageAction>
            )}
          </MessageActions>
        </>
      )}
    </div>
  );
};

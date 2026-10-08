"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenIcon,
  CheckIcon,
  CopyIcon,
  HammerIcon,
  ListChecksIcon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";

import {
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { splitSlashSkills } from "@/features/skills/parse-slash";
import { cn } from "@/lib/utils";

import type { Doc } from "../../../../convex/_generated/dataModel";
import { sanitizeAgentText } from "../agent-steps";
import { userMessageBlocks } from "../user-message";
import { AgentRun, useRunStalled } from "./agent-run";

interface UserMessageProps {
  content: string;
  /** Attached images, shown as thumbnails above the text. */
  imageUrls?: string[];
  /** Enabled skills: leading `/name` tokens naming one show as a chip. */
  skillNames?: ReadonlySet<string>;
  /** Sent while the conversation was open (not history): fades up on mount. */
  animate?: boolean;
}

export const UserMessage = ({
  content,
  imageUrls = [],
  skillNames,
  animate = false,
}: UserMessageProps) => {
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const { skills, text } = useMemo(() => {
    const { names, rest } = splitSlashSkills(content);
    const skills = names.filter((name) => skillNames?.has(name));
    if (skills.length === 0) return { skills, text: content };
    // Tokens that name no enabled skill stay in the text as typed.
    const others = names.filter((name) => !skillNames?.has(name));
    return { skills, text: others.map((name) => `/${name} `).join("") + rest };
  }, [content, skillNames]);
  const blocks = useMemo(() => userMessageBlocks(text), [text]);

  useEffect(() => {
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [content]);

  return (
    // min-w-0 + overflow-wrap:anywhere: a long unbroken token (URL, path) must
    // wrap instead of widening the bubble past the panel.
    <div
      className={cn(
        "ml-auto flex min-w-0 max-w-[90%] flex-col items-end @sm:max-w-[85%]",
        animate && "animate-fade-up motion-reduce:animate-none",
      )}
    >
      {imageUrls.length > 0 && (
        <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
          {imageUrls.map((url, index) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element -- Convex storage URL */}
              <img
                src={url}
                // A CORS request: the WebContainer engine's COEP (require-corp)
                // blocks plain cross-origin images, and Convex storage sends CORS.
                crossOrigin="anonymous"
                alt={`Attached image ${index + 1}`}
                className="size-20 rounded-lg border object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {(content.trim() || skills.length > 0) && (
        <div
          ref={textRef}
          className={cn(
            "min-w-0 max-w-full space-y-2 overflow-hidden rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm/6 [overflow-wrap:anywhere]",
            // 8 lines of text/6.
            !expanded && "max-h-52",
          )}
        >
          {skills.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {skills.map((name) => (
                <Badge
                  key={name}
                  variant="outline"
                  title={`Skill: ${name}`}
                  className="bg-background/60 font-medium"
                >
                  <BookOpenIcon />/{name}
                </Badge>
              ))}
            </div>
          )}
          {blocks.map((block, index) =>
            block.kind === "code" ? (
              <pre
                key={index}
                className="-mx-1.5 overflow-x-auto rounded-md bg-background/60 px-2 py-1.5 font-mono text-xs/5 [overflow-wrap:normal]"
              >
                {block.text}
              </pre>
            ) : (
              <p key={index} className="whitespace-pre-wrap">
                {block.text}
              </p>
            ),
          )}
        </div>
      )}
      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 mr-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
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
  /** Set when a checkpoint was taken before this run (#43). */
  onRestore?: () => void;
  /** A plan-mode reply (#120): sends the plan as the next build message. */
  onBuildPlan?: () => void;
}

export const AssistantMessage = ({
  message,
  isLast,
  pathOf,
  onOpenFile,
  onRetry,
  onRestore,
  onBuildPlan,
}: AssistantMessageProps) => {
  const [copied, setCopied] = useState(false);
  const status = message.status ?? "completed";
  const steps = message.steps ?? [];
  const content = sanitizeAgentText(message.content, pathOf);
  // Safety net for a run that died without reporting back (e.g. the worker
  // crashed): after a long silence, offer a retry instead of a bare spinner.
  // The server fails such a run for good after LOST_RUN_MS.
  const stalled = useRunStalled(message);
  // Seen running: the reply settles in once it completes. A reply loaded
  // already completed (history) stays still.
  const [startedProcessing] = useState(status === "processing");
  const settle = startedProcessing && "animate-fade-up motion-reduce:animate-none";
  const isPlan = message.mode === "plan";

  const restoreAction = onRestore && status !== "processing" && (
    <MessageAction
      size="icon-sm"
      label="Restore to before this run"
      tooltip="Restore to before this run"
      onClick={onRestore}
      className="size-7 text-muted-foreground hover:text-foreground"
    >
      <Undo2Icon className="size-3.5" />
    </MessageAction>
  );

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
          model={message.runModel?.label}
          stalled={stalled}
          onOpenFile={onOpenFile}
        />
      )}
      {stalled && isLast && onRetry && (
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5.5 items-center rounded-full bg-destructive/10 px-2 text-[11.5px] text-destructive">
            Taking too long
          </span>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RotateCcwIcon className="size-3.5" />
            Retry
          </Button>
        </div>
      )}
      {status === "cancelled" && steps.length === 0 && (
        <p className="text-sm text-muted-foreground">Request cancelled</p>
      )}
      {/* A stopped run may still have changed files. */}
      {status === "cancelled" && restoreAction && (
        <MessageActions className="-ml-1.5 -mt-1">{restoreAction}</MessageActions>
      )}
      {status === "completed" && content && (
        <>
          {isPlan && (
            <Badge variant="outline" className={cn("-mb-1 text-muted-foreground", settle)}>
              <ListChecksIcon />
              Plan
            </Badge>
          )}
          <MessageResponse
            className={cn("chat-prose", settle)}
            controls={{ code: { copy: true, download: false } }}
          >
            {content}
          </MessageResponse>
          {isPlan && isLast && onBuildPlan && (
            <Button
              type="button"
              size="sm"
              onClick={onBuildPlan}
              className={cn("self-start", settle)}
            >
              <HammerIcon className="size-3.5" />
              Build this plan
            </Button>
          )}
          <MessageActions
            className={cn(
              "-ml-1.5 -mt-1 opacity-0 transition-opacity duration-100 group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
              startedProcessing && "animate-in fade-in-0 duration-300 motion-reduce:animate-none",
            )}
          >
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
            {restoreAction}
          </MessageActions>
        </>
      )}
    </div>
  );
};

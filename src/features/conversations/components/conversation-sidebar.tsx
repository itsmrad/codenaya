import ky from "ky";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { 
  CopyIcon,
  HistoryIcon,
  LoaderIcon, 
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { FileIcon } from "@react-symbols/icons/utils";
import { BsArrowsCollapse, BsArrowsExpand } from "react-icons/bs";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApprovalPrompt } from "@/features/integrations/components/approval-prompt";

import {
  useConversation,
  useConversations,
  useCreateConversation,
  useMessages,
} from "../hooks/use-conversations";

import { Doc, Id } from "../../../../convex/_generated/dataModel";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { PastConversationsDialog } from "./past-conversations-dialog";
import { useChatStore } from "../store/use-chat-store";

/**
 * Short, Claude Code-style verbs for the agent's tool names. Anything not
 * listed falls back to the raw name, so a newly added tool degrades to
 * something readable rather than disappearing from the timeline.
 */
const TOOL_LABELS: Record<string, string> = {
  createFiles: "Write",
  createFolder: "Mkdir",
  deleteFiles: "Delete",
  listFiles: "List",
  readFiles: "Read",
  renameFile: "Rename",
  scrapeUrls: "Fetch",
  setEnvVar: "SetEnv",
  updateFile: "Edit",
};

/** What each tool is for, shown under the tool name so every step explains itself. */
const TOOL_HINTS: Record<string, string> = {
  createFiles: "Writing new files",
  createFolder: "Creating a folder",
  deleteFiles: "Removing files",
  listFiles: "Looking at the project structure",
  readFiles: "Reading file contents",
  renameFile: "Renaming a file",
  scrapeUrls: "Reading documentation",
  setEnvVar: "Saving an environment variable",
  updateFile: "Updating file contents",
};

type MessagePart = NonNullable<Doc<"messages">["parts"]>[number];

/** Last path segment, so a long path shows as just the file name. URLs pass through. */
const baseName = (label: string) =>
  /^https?:\/\//.test(label) ? label : label.split("/").filter(Boolean).pop() ?? label;

/** One-line summary for a collapsed thought: its opening sentence. */
const firstSentence = (text: string) =>
  text.split(/(?<=[.!?]["'”’)]?)\s+|\n/)[0].trim();

const STATUS_DOT: Record<MessagePart["status"], string> = {
  running: "bg-amber-500 animate-pulse",
  done: "bg-emerald-500",
  error: "bg-destructive",
};

/**
 * The agent's turn as a vertical timeline: thinking steps (collapsed) and tool
 * calls in the order they happened, with a live "Working…" row at the end
 * while the agent is still busy and hasn't started its answer.
 */
const ActivityTimeline = ({
  parts,
  working,
}: {
  parts: MessagePart[];
  working: boolean;
}) => (
  <div className="relative mb-4 flex flex-col gap-3 pl-5 text-sm before:absolute before:top-2 before:bottom-2 before:left-[3.5px] before:w-px before:bg-border">
    {parts.map((part) =>
      part.toolName === "narration" ? (
        <div key={part.partId} className="relative text-foreground/90">
          <span className="absolute top-1.5 -left-5 size-2 rounded-full bg-muted-foreground/60" />
          <MessageResponse className="text-sm [&_p]:my-0">{part.text ?? ""}</MessageResponse>
        </div>
      ) : part.text ? (
        <details key={part.partId} className="group relative">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="absolute top-1.5 -left-5 size-2 rounded-full bg-muted-foreground/60" />
            <span className="truncate">{firstSentence(part.text)}</span>
            <BsArrowsExpand className="size-3.5 shrink-0 opacity-0 transition group-hover:opacity-100 group-open:hidden" />
            <BsArrowsCollapse className="hidden size-3.5 shrink-0 group-open:block" />
          </summary>
          <div className="mt-2 max-h-60 overflow-y-auto border-l-2 border-border pl-3">
            <MessageResponse className="text-xs leading-relaxed text-muted-foreground [&_p]:my-1.5">
              {part.text}
            </MessageResponse>
          </div>
        </details>
      ) : (
        <div key={part.partId} className="relative min-w-0">
          <span className={cn("absolute top-1.5 -left-5 size-2 rounded-full", STATUS_DOT[part.status])} />
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-semibold text-foreground">
              {TOOL_LABELS[part.toolName] ?? part.toolName}
            </span>
            {part.label && (
              <span className="truncate font-mono text-[13px] text-sky-500 dark:text-sky-400">
                {baseName(part.label)}
              </span>
            )}
          </div>
          <div
            title={part.label}
            className={cn(
              "mt-0.5 truncate text-xs",
              part.status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {part.status === "error"
              ? "Failed"
              : `${TOOL_HINTS[part.toolName] ?? "Running tool"}${part.status === "running" ? "…" : ""}`}
          </div>
        </div>
      )
    )}
    {working && (
      <div className="relative flex items-center text-muted-foreground">
        <LoaderIcon className="absolute top-[3px] -left-[23px] size-3.5 animate-spin bg-background" />
        {parts.length ? "Working…" : "Thinking…"}
      </div>
    )}
  </div>
);

/**
 * Reveals streamed text a character at a time. Chunks land in ~60-char bursts,
 * so the visible text trails the received text and catches up smoothly.
 * Messages already complete on mount render in full immediately.
 */
const StreamingResponse = ({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) => {
  const [shown, setShown] = useState(streaming ? 0 : content.length);
  const caughtUp = shown >= content.length;

  useEffect(() => {
    if (caughtUp) return;

    const frame = requestAnimationFrame(() => {
      // ponytail: 1 char/frame when close, up to 8 when far behind so long
      // replies don't take minutes; tune the divisor/cap if it feels off.
      const step = Math.min(8, Math.max(1, Math.ceil((content.length - shown) / 40)));
      setShown((s) => Math.min(content.length, s + step));
    });

    return () => cancelAnimationFrame(frame);
  }, [caughtUp, content.length, shown]);

  return (
    <>
      <MessageResponse isAnimating={streaming || !caughtUp}>
        {content.slice(0, shown)}
      </MessageResponse>
      {(streaming || !caughtUp) && (
        <span
          aria-hidden="true"
          className="inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground/70"
        />
      )}
    </>
  );
};

interface ConversationSidebarProps {
  projectId: Id<"projects">;
};

export const ConversationSidebar = ({
  projectId,
}: ConversationSidebarProps) => {
  const { input, setInput, contexts, removeContext, clearContexts } = useChatStore();
  const [
    selectedConversationId,
    setSelectedConversationId,
  ] = useState<Id<"conversations"> | null>(null);
  const [
    pastConversationsOpen,
    setPastConversationsOpen
  ] = useState(false);

  const createConversation = useCreateConversation();
  const conversations = useConversations(projectId);

  const activeConversationId =
    selectedConversationId ?? conversations?.[0]?._id ?? null;

  const activeConversation = useConversation(activeConversationId);
  const conversationMessages = useMessages(activeConversationId);

  // Check if any message is currently processing
  const isProcessing = conversationMessages?.some(
    (msg) => msg.status === "processing"
  );

  const handleCancel = async () => {
    try {
      await ky.post("/api/messages/cancel", {
        json: { projectId },
      });
    } catch {
      toast.error("Unable to cancel request");
    }
  };

  const handleCreateConversation = async () => {
    try {
      const newConversationId = await createConversation({
        projectId,
        title: DEFAULT_CONVERSATION_TITLE,
      });
      setSelectedConversationId(newConversationId);
      return newConversationId;
    } catch {
      toast.error("Unable to create new conversation");
      return null;
    }
  };

  // Resends the prompt that produced the last reply as a new turn.
  const handleRetry = async (message: string) => {
    if (!activeConversationId || isProcessing) {
      return;
    }

    try {
      await ky.post("/api/messages", {
        json: { conversationId: activeConversationId, message },
      });
    } catch {
      toast.error("Retry failed");
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    // If processing and no new message, this is just a stop function
    if (isProcessing && !message.text && contexts.length === 0) {
      await handleCancel()
      setInput("");
      return;
    }

    let conversationId = activeConversationId;

    if (!conversationId) {
      conversationId = await handleCreateConversation();
      if (!conversationId) {
        return;
      }
    }

    let finalMessage = message.text;
    if (contexts.length > 0) {
      const contextStrs = contexts.map(
        (c) => `File: ${c.fileName} (Lines ${c.startLine}-${c.endLine})\n\`\`\`\n${c.content}\n\`\`\``
      );
      finalMessage = `${contextStrs.join("\n\n")}\n\n${finalMessage}`;
    }

    // Trigger Inngest function via API
    try {
      await ky.post("/api/messages", {
        json: {
          conversationId,
          message: finalMessage,
        },
      });
      // Only clear contexts after a successful send so they aren't lost on failure
      clearContexts();
    } catch {
      toast.error("Message failed to send");
    }

    setInput("");
  }

  return (
    <>
      <PastConversationsDialog
        projectId={projectId}
        open={pastConversationsOpen}
        onOpenChange={setPastConversationsOpen}
        onSelect={setSelectedConversationId}
      />
      <div className="flex flex-col h-full bg-sidebar">
        <div className="h-8.75 flex items-center justify-between border-b">
          <div className="text-sm truncate pl-3">
            {activeConversation?.title ?? DEFAULT_CONVERSATION_TITLE}
          </div>
          <div className="flex items-center px-1 gap-1">
            <Button
              size="icon-xs"
              variant="highlight"
              onClick={() => setPastConversationsOpen(true)}
            >
              <HistoryIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="highlight"
              onClick={handleCreateConversation}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        <Conversation className="flex-1">
          <ConversationContent>
            {conversationMessages?.map((message, messageIndex) => (
              <Message
                key={message._id}
                from={message.role}
              >
                <MessageContent>
                  {message.role === "assistant" &&
                    (!!message.parts?.length ||
                      (message.status === "processing" && !message.content)) && (
                      // Once the first answer delta lands the text itself is
                      // the progress indicator, so the "Working…" row is only
                      // for the window before the model starts its answer.
                      <ActivityTimeline
                        parts={message.parts ?? []}
                        working={message.status === "processing" && !message.content}
                      />
                    )}
                  {message.status === "processing" && !message.content ? null : message.status === "cancelled" ? (
                    <span className="text-muted-foreground italic">
                      Request cancelled
                    </span>
                  ) : (
                    <StreamingResponse
                      content={message.content}
                      streaming={message.status === "processing"}
                    />
                  )}
                </MessageContent>
                {message.role === "assistant" &&
                  (message.status === "completed" || message.status === "cancelled") &&
                  messageIndex === (conversationMessages?.length ?? 0) - 1 && (
                    <MessageActions>
                      {message.status === "completed" && (
                        <MessageAction
                          onClick={() => {
                            navigator.clipboard.writeText(message.content)
                          }}
                          label="Copy"
                        >
                          <CopyIcon className="size-3" />
                        </MessageAction>
                      )}
                      {conversationMessages?.[messageIndex - 1]?.role === "user" && (
                        <MessageAction
                          onClick={() => handleRetry(conversationMessages[messageIndex - 1].content)}
                          label="Retry"
                        >
                          <RotateCcwIcon className="size-3" />
                        </MessageAction>
                      )}
                    </MessageActions>
                  )
                }
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="p-3">
          {/* Sits directly above the composer rather than inside the
              transcript: the agent is blocked waiting on this answer, and the
              message list can be scrolled away from the bottom, which would
              hide the prompt exactly when it matters. */}
          <ApprovalPrompt projectId={projectId} />
          <PromptInput 
            onSubmit={handleSubmit}
            className="mt-2"
          >
            <PromptInputBody>
              {contexts.length > 0 && (
                <div className="flex w-full flex-wrap justify-start gap-2 p-2 pb-0">
                  {contexts.map((ctx) => (
                    <div key={ctx.id} className="group relative flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs">
                      <FileIcon fileName={ctx.fileName} autoAssign className="size-3.5" />
                      <span className="font-medium text-muted-foreground">
                        {ctx.fileName} <span className="text-muted-foreground/70 text-[10px]">#L{ctx.startLine}-{ctx.endLine}</span>
                      </span>
                      <button 
                        type="button"
                        onClick={() => removeContext(ctx.id)}
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <PromptInputTextarea
                placeholder="Ask Codenaya anything..."
                onChange={(e) => setInput(e.target.value)}
                value={input}
                disabled={isProcessing}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit
                disabled={isProcessing ? false : (!input && contexts.length === 0)}
                status={isProcessing ? "streaming" : undefined}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </>
  );
};

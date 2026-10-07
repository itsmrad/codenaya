import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";
import { 
  ArrowBigUpIcon,
  ArrowUpIcon,
  CornerDownLeftIcon,
  HistoryIcon, 
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { FileIcon } from "@react-symbols/icons/utils";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ApprovalPrompt } from "@/features/integrations/components/approval-prompt";
import { useProjectIntegrations } from "@/features/integrations/components/project-integrations-context";
import { detectCredential } from "@/features/integrations/credential-guard";
import { useEditor } from "@/features/editor/hooks/use-editor";
import { useFiles } from "@/features/projects/hooks/use-files";

import {
  useConversation,
  useConversations,
  useCreateConversation,
  useMessages,
} from "../hooks/use-conversations";

import { Id } from "../../../../convex/_generated/dataModel";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { PastConversationsDialog } from "./past-conversations-dialog";
import { useChatStore } from "../store/use-chat-store";
import { useAgentModel } from "../hooks/use-agent-model";
import { AgentModelSelect } from "./agent-model-select";
import { useEnhancePrompt } from "../hooks/use-enhance-prompt";
import { EnhancePromptButton } from "./enhance-prompt-button";
import { buildPathIndex } from "../agent-steps";
import { AssistantMessage, UserMessage } from "./chat-message";
import { useRunStalled } from "./agent-run";
import { ChatEmptyState } from "./chat-empty-state";

interface ConversationSidebarProps {
  projectId: Id<"projects">;
};

export const ConversationSidebar = ({
  projectId,
}: ConversationSidebarProps) => {
  const { openIntegrations } = useProjectIntegrations();
  const { input, setInput, contexts, removeContext, clearContexts } = useChatStore();
  const [agentModel, setAgentModel] = useAgentModel();
  const enhancer = useEnhancePrompt(input, setInput);
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

  // Resolves file ids in agent text to paths, and step chips back to files.
  const files = useFiles(projectId);
  const { openFile } = useEditor(projectId);
  const { pathOf, idOfPath } = useMemo(() => {
    const index = buildPathIndex(files ?? []);
    const ids = new Map<string, Id<"files">>();
    for (const file of files ?? []) {
      if (file.type === "file") ids.set(index(file._id) ?? file.name, file._id);
    }
    return { pathOf: index, idOfPath: ids };
  }, [files]);

  const handleOpenFile = (path: string) => {
    const fileId = idOfPath.get(path);
    if (fileId) openFile(fileId, { pinned: true });
  };

  // Check if any message is currently processing. A stalled run doesn't
  // count: the composer offers Send (which clears it) rather than Stop.
  const processingMessage = conversationMessages?.findLast(
    (msg) => msg.status === "processing"
  );
  const stalled = useRunStalled(processingMessage);
  const isProcessing = Boolean(processingMessage) && !stalled;

  const handleCancel = async () => {
    try {
      await ky.post("/api/messages/cancel", {
        json: { projectId },
      });
    } catch {
      toast.error("Unable to cancel request");
    }
  };

  // Esc stops a running agent. The textarea is disabled while running, so
  // listen on the document, but only when focus isn't elsewhere (a dialog or
  // the editor), where Esc means something else.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isProcessing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const inPanel =
        !active || active === document.body || panelRef.current?.contains(active);
      if (event.key === "Escape" && !event.defaultPrevented && inPanel) {
        void handleCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // handleCancel only depends on projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing, projectId]);

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

  /**
   * Sends a message to the active conversation (creating one if needed).
   * Resolves to "sent", "failed" (the request errored), or "blocked" (never
   * sent: it contained a credential or no conversation could be created).
   */
  const sendMessage = async (
    text: string,
  ): Promise<"sent" | "failed" | "blocked"> => {
    if (detectCredential(text).detected) {
      toast.error(
        "Credentials cannot be sent in chat. Add this MCP connection through Integrations instead.",
      );
      openIntegrations();
      return "blocked";
    }

    let conversationId = activeConversationId;

    if (!conversationId) {
      conversationId = await handleCreateConversation();
      if (!conversationId) {
        return "blocked";
      }
    }

    // Trigger Inngest function via API
    try {
      await ky.post("/api/messages", {
        json: {
          conversationId,
          message: text,
          model: agentModel,
        },
      });
      return "sent";
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = await error.response
          .json<{ code?: string; error?: string }>()
          .catch(() => ({ code: undefined, error: undefined }));
        if (body.code === "credential_detected") {
          toast.error(
            "Credentials cannot be sent in chat. Add this MCP connection through Integrations instead.",
          );
          openIntegrations();
          return "blocked";
        }
        // The reply is already marked failed in the chat, with a retry action.
        if (body.code === "dispatch_failed" && body.error) {
          toast.error(body.error);
          return "failed";
        }
      }
      toast.error("Message failed to send");
      return "failed";
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    // If processing and no new message, this is just a stop function
    if (isProcessing && !message.text && contexts.length === 0) {
      await handleCancel()
      setInput("");
      return;
    }

    let finalMessage = message.text;
    if (contexts.length > 0) {
      const contextStrs = contexts.map(
        (c) => `File: ${c.fileName} (Lines ${c.startLine}-${c.endLine})\n\`\`\`\n${c.content}\n\`\`\``
      );
      finalMessage = `${contextStrs.join("\n\n")}\n\n${finalMessage}`;
    }

    const result = await sendMessage(finalMessage);
    if (result === "blocked") return;
    // Only clear contexts after a successful send so they aren't lost on failure
    if (result === "sent") clearContexts();

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
      <div ref={panelRef} className="@container flex flex-col h-full bg-sidebar">
        <div className="h-8.75 flex items-center justify-between border-b">
          <div className="text-sm font-medium truncate pl-3">
            {activeConversation?.title ?? DEFAULT_CONVERSATION_TITLE}
          </div>
          <div className="flex items-center px-1 gap-1">
            <Button
              size="icon-xs"
              variant="highlight"
              aria-label="Past conversations"
              title="Past conversations"
              onClick={() => setPastConversationsOpen(true)}
            >
              <HistoryIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="highlight"
              aria-label="New conversation"
              title="New conversation"
              onClick={handleCreateConversation}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        {conversationMessages?.length === 0 ? (
          <ChatEmptyState
            onSelect={(prompt) => void handleSubmit({ text: prompt, files: [] })}
          />
        ) : (
        <Conversation className="flex-1">
          <ConversationContent className="gap-6 px-4 py-4 pb-12">
            {conversationMessages?.map((message, messageIndex) =>
              message.role === "user" ? (
                <UserMessage key={message._id} content={message.content} />
              ) : (
                <AssistantMessage
                  key={message._id}
                  message={message}
                  isLast={messageIndex === conversationMessages.length - 1}
                  pathOf={pathOf}
                  onOpenFile={handleOpenFile}
                  onRetry={() => {
                    const prompt = conversationMessages
                      .slice(0, messageIndex)
                      .findLast((m) => m.role === "user");
                    // Resend the prompt as-is, leaving the composer draft and
                    // attached contexts alone.
                    if (prompt) void sendMessage(prompt.content);
                  }}
                />
              ),
            )}
          </ConversationContent>
          <ConversationScrollButton
            aria-label="Scroll to bottom"
            className="bottom-3 size-8 border-border bg-background/90 shadow-sm backdrop-blur transition-opacity duration-150 dark:bg-background/90"
          />
        </Conversation>
        )}
        <div className="chat-composer px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
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
                placeholder="Describe a change or ask a question…"
                className="min-h-11 px-3 pt-3 pb-1 text-sm/6 placeholder:text-muted-foreground/70"
                onChange={(e) => setInput(e.target.value)}
                value={input}
                disabled={isProcessing || enhancer.isEnhancing}
              />
            </PromptInputBody>
            <PromptInputFooter className="h-10 px-2 py-0">
              {/* The tools shrink (the model name truncates) so a narrow
                  panel never pushes the send button out of view. */}
              <PromptInputTools className="min-w-0">
                {/* Attachment slot: shown disabled until uploads ship. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="rounded-lg">
                      <PromptInputButton
                        disabled
                        aria-label="Attach files"
                        className="size-8 rounded-lg"
                      >
                        <PlusIcon className="size-4" />
                      </PromptInputButton>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Attachments coming soon</TooltipContent>
                </Tooltip>
                <EnhancePromptButton
                  enhancer={enhancer}
                  value={input}
                  disabled={isProcessing}
                />
                <AgentModelSelect
                  value={agentModel}
                  onValueChange={setAgentModel}
                  disabled={isProcessing}
                />
              </PromptInputTools>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden items-center gap-1 text-[11px] text-muted-foreground/70 @[400px]:inline-flex">
                  <kbd className="inline-flex h-4 items-center rounded border px-1 font-sans">
                    <CornerDownLeftIcon className="size-2.5" />
                    <span className="sr-only">Enter</span>
                  </kbd>
                  send ·
                  <kbd className="inline-flex h-4 items-center gap-0.5 rounded border px-1 font-sans">
                    <ArrowBigUpIcon className="size-2.5" />
                    <CornerDownLeftIcon className="size-2.5" />
                    <span className="sr-only">Shift+Enter</span>
                  </kbd>
                  newline
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PromptInputSubmit
                      disabled={
                        isProcessing
                          ? false
                          : enhancer.isEnhancing || (!input && contexts.length === 0)
                      }
                      aria-label={isProcessing ? "Stop" : "Send"}
                      className="size-8 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                    >
                      {isProcessing ? (
                        <SquareIcon className="size-3 fill-current" />
                      ) : (
                        <ArrowUpIcon className="size-4" />
                      )}
                    </PromptInputSubmit>
                  </TooltipTrigger>
                  <TooltipContent>{isProcessing ? "Stop (Esc)" : "Send (Enter)"}</TooltipContent>
                </Tooltip>
              </div>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </>
  );
};

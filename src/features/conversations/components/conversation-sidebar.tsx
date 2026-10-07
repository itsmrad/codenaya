import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useMemo, useState } from "react";
import { 
  HistoryIcon, 
  PlusIcon,
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
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
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
import { buildPathIndex } from "../agent-steps";
import { AssistantMessage, UserMessage } from "./chat-message";

interface ConversationSidebarProps {
  projectId: Id<"projects">;
};

export const ConversationSidebar = ({
  projectId,
}: ConversationSidebarProps) => {
  const { openIntegrations } = useProjectIntegrations();
  const { input, setInput, contexts, removeContext, clearContexts } = useChatStore();
  const [agentModel, setAgentModel] = useAgentModel();
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

    if (detectCredential(finalMessage).detected) {
      toast.error(
        "Credentials cannot be sent in chat. Add this MCP connection through Integrations instead.",
      );
      openIntegrations();
      return;
    }

    let conversationId = activeConversationId;

    if (!conversationId) {
      conversationId = await handleCreateConversation();
      if (!conversationId) {
        return;
      }
    }

    // Trigger Inngest function via API
    try {
      await ky.post("/api/messages", {
        json: {
          conversationId,
          message: finalMessage,
          model: agentModel,
        },
      });
      // Only clear contexts after a successful send so they aren't lost on failure
      clearContexts();
    } catch (error) {
      if (error instanceof HTTPError && error.response.status === 422) {
        const body = await error.response
          .json<{ code?: string }>()
          .catch(() => ({ code: undefined }));
        if (body.code === "credential_detected") {
          toast.error(
            "Credentials cannot be sent in chat. Add this MCP connection through Integrations instead.",
          );
          openIntegrations();
          return;
        }
      }
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
      <div className="@container flex flex-col h-full bg-sidebar">
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
                    if (prompt) void handleSubmit({ text: prompt.content, files: [] });
                  }}
                />
              ),
            )}
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
              <PromptInputTools>
                <AgentModelSelect
                  value={agentModel}
                  onValueChange={setAgentModel}
                  disabled={isProcessing}
                />
              </PromptInputTools>
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

import ky, { HTTPError } from "ky";
import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";
import { 
  ArrowBigUpIcon,
  ArrowUpIcon,
  ClockArrowUpIcon,
  CornerDownLeftIcon,
  HistoryIcon, 
  ListEndIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { FileIcon } from "@react-symbols/icons/utils";
import type { FileUIPart } from "ai";

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
  PromptInputSpeechButton,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { InputGroupButton } from "@/components/ui/input-group";
import { isPlanModeKey } from "@/lib/shortcuts";
import { useCommandPalette, useProjectCommands } from "@/lib/command-palette";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ApprovalPrompt } from "@/features/integrations/components/approval-prompt";
import { useProjectIntegrations } from "@/features/integrations/components/project-integrations-context";
import {
  useAiProviderKeys,
  usePlatformModelsOrCatalog,
} from "@/features/ai-providers/hooks/use-ai-providers";
import { modelAcceptsImages, modelIdsFor } from "@/features/ai-providers/registry";
import { resolveCatalogModel } from "@/features/ai-providers/platform";
import { detectCredential } from "@/features/integrations/credential-guard";
import { INSUFFICIENT_CREDITS_CODE } from "@/features/billing/credits";
import { MODEL_LIMIT_CODE } from "@/features/billing/model-spend";
import { isPromoRefusalCode } from "@/features/promotions/github-promo";
import { useEditor } from "@/features/editor/hooks/use-editor";
import { useFiles } from "@/features/projects/hooks/use-files";
import { MakeItMineCard } from "@/features/templates/components/make-it-mine-card";
import { BRAND_FILE } from "@/features/templates/make-it-mine";
import { useProject } from "@/features/projects/hooks/use-projects";
import {
  SkillSlashMenu,
  useSkillSlashMenu,
} from "@/features/skills/components/skill-slash-menu";
import { splitSlashSkills } from "@/features/skills/parse-slash";

import {
  useConversation,
  useConversations,
  useCreateConversation,
  useMessages,
} from "../hooks/use-conversations";

import { Doc, Id } from "../../../../convex/_generated/dataModel";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";
import { PastConversationsDialog } from "./past-conversations-dialog";
import { sendQueuedMessage, useChatStore } from "../store/use-chat-store";
import { useAgentModel } from "../hooks/use-agent-model";
import { useSwarmEnabled } from "../hooks/use-agent-tasks";
import { AgentModelSelect } from "./agent-model-select";
import { LowCreditsNotice } from "./low-credits-notice";
import { useEnhancePrompt } from "../hooks/use-enhance-prompt";
import { EnhancePromptButton } from "./enhance-prompt-button";
import { type ComposerMode, PlanModeToggle } from "./plan-mode-toggle";
import {
  type MessageMode,
  diagnoseStuckMessage,
} from "../plan-mode";
import { type AgentModelChoice, nextTier } from "../agent-models";
import { buildPathIndex, stuckFilePath } from "../agent-steps";
import { AssistantMessage, UserMessage } from "./chat-message";
import { parseSuggestion, type SuggestionAction } from "../suggestions";
import { composerSubmitAction, followUpAction } from "../follow-up";
import { QueuedFollowUp } from "./queued-follow-up";
import { useRunStalled } from "./agent-run";
import { ChatEmptyState } from "./chat-empty-state";
import { chatStarters } from "../chat-starters";
import { type CancelSource, cancelRun, ESC_CONFIRM_MS, escapeToStop } from "../run-cancel";
import { type Checkpoint, useCheckpoints } from "../hooks/use-checkpoints";
import {
  CheckpointHistoryDialog,
  RestoreCheckpointDialog,
} from "./checkpoint-dialogs";
import {
  ComposerAttachButton,
  ComposerImages,
  WithAttachmentCount,
} from "./composer-attachments";
import { useUploadChatImages } from "../hooks/use-chat-images";
import { useProjectNotes } from "@/features/projects/hooks/use-project-notes";
import { type NoteDraft, ProjectNoteDialog } from "@/features/projects/components/project-notes";
import {
  dismissNoteProposal,
  isNoteProposalDismissed,
} from "@/features/projects/utils/note-proposals";
import { looksLikeLastingPreference } from "@/features/projects/notes";
import { ElementChips } from "./element-chips";
import type { SelectedElement } from "../selected-elements";
import {
  CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGE_BYTES,
} from "../chat-images";
import { visionSwitchTarget } from "../vision-switch";

// One "Press Esc again" hint at a time.
const ESC_TOAST_ID = "esc-to-stop";

interface ConversationSidebarProps {
  projectId: Id<"projects">;
  actionsInSheet?: boolean;
};

export const ConversationSidebar = ({
  projectId,
  actionsInSheet = false,
}: ConversationSidebarProps) => {
  const { openIntegrations } = useProjectIntegrations();
  const { input, setInput, appendInput, contexts, removeContext, clearContexts, elements, removeElement, clearElements } = useChatStore();
  // A next-step chip's IDE action; false when this page doesn't offer it, so
  // the chip fills the composer instead.
  const runSuggestionAction = (action: SuggestionAction) => {
    if (action.kind === "connect") {
      // shortcut: opens the dialog without the provider picked; use
      // CONNECTORS' integrationLink once its ?integrations= handling lands,
      // keeping the other query params (engine).
      openIntegrations();
      return true;
    }
    const run = useCommandPalette.getState().commands[action.kind];
    run?.();
    return Boolean(run);
  };
  const [agentModel, setAgentModel] = useAgentModel();
  const enhancer = useEnhancePrompt(input, setInput);
  const slashMenu = useSkillSlashMenu(projectId, input, setInput);
  const uploadImages = useUploadChatImages(projectId);
  // null: an older backend without notes, so the actions stay hidden (#630).
  const notes = useProjectNotes(projectId);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [dismissedProposalId, setDismissedProposalId] = useState<string | null>(null);
  const dismissProposal = (messageId: string) => {
    dismissNoteProposal(projectId, messageId);
    setDismissedProposalId(messageId);
  };
  const [chosenMode, setMode] = useState<ComposerMode>("build");
  const swarmEnabled = useSwarmEnabled();
  // Swarm switched off mid-draft falls back to Build.
  const mode = chosenMode === "swarm" && !swarmEnabled ? "build" : chosenMode;
  // A key still loading (or gone) is left to the server to check.
  const modelKeys = useAiProviderKeys();
  const platform = usePlatformModelsOrCatalog();
  const modelKey = modelKeys?.find((key) => key._id === agentModel.keyId);
  const acceptsImages = !agentModel.keyId
    ? resolveCatalogModel(platform, agentModel.modelId).vision
    : !modelKey || modelAcceptsImages(agentModel.modelId, modelKey);
  const visionSwitch = acceptsImages ? undefined : visionSwitchTarget(agentModel, platform, modelKey);
  const [
    selectedConversationId,
    setSelectedConversationId,
  ] = useState<Id<"conversations"> | null>(null);
  const [
    pastConversationsOpen,
    setPastConversationsOpen
  ] = useState(false);

  const [checkpointHistoryOpen, setCheckpointHistoryOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Checkpoint | null>(null);
  const checkpoints = useCheckpoints(projectId);
  const checkpointByMessage = useMemo(
    () => new Map(checkpoints?.map((checkpoint) => [checkpoint.messageId, checkpoint])),
    [checkpoints],
  );

  const createConversation = useCreateConversation();
  const conversations = useConversations(projectId);

  const activeConversationId =
    selectedConversationId ?? conversations?.[0]?._id ?? null;

  const activeConversation = useConversation(activeConversationId);
  // Each conversation keeps its own follow-up (#257); only the open one's shows.
  const followUp = useChatStore((state) =>
    activeConversationId ? state.followUps[activeConversationId] : undefined,
  );
  const { setFollowUp, takeFollowUp } = useChatStore.getState();
  const conversationMessages = useMessages(activeConversationId);

  // The message being sent shows at once, until its saved copy arrives; the
  // request saves it only after a few server round-trips.
  const [pending, setPending] = useState<{
    text: string;
    imageUrls: string[];
    elements?: SelectedElement[];
    userCount: number;
  } | null>(null);
  const userCount =
    conversationMessages?.filter((message) => message.role === "user").length ?? 0;

  // Messages already there when a conversation opens are history; only those
  // that arrive while it is open animate in.
  const [history, setHistory] = useState<{
    conversationId: Id<"conversations"> | null;
    messageIds: ReadonlySet<string>;
  } | null>(null);
  if (conversationMessages && history?.conversationId !== activeConversationId) {
    setHistory({
      conversationId: activeConversationId,
      messageIds: new Set(conversationMessages.map((message) => message._id)),
    });
  }

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

  // Wait for the project, and its files unless it's an import (those load
  // after the import), so the starters don't swap while loading.
  const project = useProject(projectId);
  const starters =
    project && (project.importStatus || files !== undefined)
      ? chatStarters({
          name: project.name,
          imported: Boolean(project.importStatus),
          hasFiles: Boolean(files?.length),
        })
      : null;
  // No conversation yet (import, Duplicate, Remix, blank create) or an empty one.
  const isEmpty = activeConversationId
    ? conversationMessages?.length === 0
    : conversations !== undefined;

  const handleOpenFile = (path: string) => {
    const fileId = idOfPath.get(path);
    if (!fileId) return;
    openFile(fileId, { pinned: true });
    // The workspace may be on Preview (a run switches to it) or, below desktop, on Chat.
    useCommandPalette.getState().commands["show-code"]?.();
  };

  // Check if any message is currently processing. A stalled run doesn't
  // count: the composer offers Send (which clears it) rather than Stop.
  const processingMessage = conversationMessages?.findLast(
    (msg) => msg.status === "processing"
  );
  const stalled = useRunStalled(processingMessage);
  const isProcessing = Boolean(processingMessage) && !stalled;

  // When Send last turned into Stop, for the Stop grace period.
  const processingSinceRef = useRef(0);
  useEffect(() => {
    if (isProcessing) processingSinceRef.current = Date.now();
  }, [isProcessing]);

  const handleCancel = async (source: CancelSource) => {
    try {
      await cancelRun(projectId, source, processingSinceRef.current);
    } catch {
      toast.error("Unable to cancel request");
    }
  };

  // Esc twice stops a running agent, from the composer or the document, but
  // only when focus isn't elsewhere (a dialog or the editor), where Esc means
  // something else.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isProcessing) return;
    const pressEscape = escapeToStop();
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const inPanel =
        !active || active === document.body || panelRef.current?.contains(active);
      if (!inPanel) return;
      const press = pressEscape(event);
      if (press === "confirm") {
        toast("Press Esc again to stop", { id: ESC_TOAST_ID, duration: ESC_CONFIRM_MS });
      } else if (press === "stop") {
        toast.dismiss(ESC_TOAST_ID);
        void handleCancel("esc");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      toast.dismiss(ESC_TOAST_ID);
    };
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

  useProjectCommands({
    "new-conversation": () => void handleCreateConversation(),
    "past-conversations": () => setPastConversationsOpen(true),
    "version-history": () => setCheckpointHistoryOpen(true),
  });

  /**
   * Sends a message to the active conversation (creating one if needed).
   * Resolves to "sent", "failed" (saved, but the reply is marked failed with a
   * retry action), or "blocked" (not saved: it contained a credential, no
   * conversation could be created, or the request errored).
   */
  const sendMessage = async (
    text: string,
    images?: Id<"_storage">[],
    mode?: MessageMode,
    model: AgentModelChoice = agentModel,
    elements?: SelectedElement[],
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
          model,
          images,
          elements: elements?.length ? elements : undefined,
          mode,
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
        // Platform AI has no key, a promo model can't run (ADR 0009), or the
        // user is out of credits (ADR 0011) or the model hit its limit (ADR 0012):
        // nothing was saved, so keep the draft.
        const refused =
          body.code === "ai_not_configured" ||
          body.code === INSUFFICIENT_CREDITS_CODE ||
          body.code === MODEL_LIMIT_CODE ||
          isPromoRefusalCode(body.code);
        if (refused && body.error) {
          toast.error(body.error);
          return "blocked";
        }
        // The reply is already marked failed in the chat, with a retry action.
        if (body.code === "dispatch_failed" && body.error) {
          toast.error(body.error);
          return "failed";
        }
      }
      toast.error("Message failed to send");
      return "blocked";
    }
  };

  // Panels outside the chat hold their sends (the preview's Fix) while one is in flight.
  useEffect(() => {
    useChatStore.setState({ sendPending: pending !== null });
  }, [pending]);

  // Messages queued from outside the chat ("Ask agent to fix", #300; the
  // preview's "Fix with AI", #223) are sent once the agent is free, through the
  // same path as a typed one, leaving the composer draft alone. Like a typed
  // message, it shows at once as pending.
  const queuedMessage = useChatStore((state) => state.queuedMessage);
  useEffect(() => {
    // Wait for the conversation list, or the send would open a new conversation.
    if (
      !queuedMessage ||
      queuedMessage.sending ||
      pending ||
      isProcessing ||
      conversations === undefined
    ) {
      return;
    }
    // Syncing with the chat store: the send is the external effect.
    sendQueuedMessage(projectId, async (text) => {
      setPending({ text, imageUrls: [], userCount });
      try {
        return await sendMessage(text);
      } finally {
        setPending(null);
      }
    }).catch(() => toast.error("Message failed to send"));
    // sendMessage is recreated every render; the queued message is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedMessage, pending, isProcessing, conversations, projectId]);

  // A follow-up typed during a run (#257) goes out once that run completes,
  // after any message queued from outside the chat, leaving the draft alone.
  // A stopped or failed run gives it back to the composer instead.
  const followUpNext =
    followUp &&
    followUpAction(
      followUp,
      conversationMessages,
      Boolean(pending || isProcessing || queuedMessage),
      stalled ? processingMessage?._id : undefined,
    );
  useEffect(() => {
    if (!activeConversationId || !followUpNext || followUpNext === "wait") return;
    // Taken from the store, so a re-run of this effect can't act on it twice.
    const taken = takeFollowUp(activeConversationId);
    if (!taken) return;
    if (followUpNext === "drop") {
      appendInput(taken.text);
      toast.info("The run didn't finish, so your queued message wasn't sent. It's back in the composer.");
      return;
    }
    const { text, mode: queuedMode } = taken;
    // Like a typed message, it shows at once as pending; the send is the external effect.
    void (async () => {
      setPending({ text, imageUrls: [], userCount });
      try {
        if ((await sendMessage(text, undefined, queuedMode)) === "blocked") {
          appendInput(text);
        }
      } catch {
        toast.error("Message failed to send");
      } finally {
        setPending(null);
      }
    })();
    // sendMessage is recreated every render; the follow-up's state is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, followUpNext]);

  const handleSubmit = async (message: PromptInputMessage) => {
    // During a run, a submit only queues one follow-up for when it ends
    // (#257); stopping is the Stop button's or Esc's job.
    const action = composerSubmitAction({
      running: isProcessing,
      text: message.text,
      hasImages: message.files.length > 0,
      hasFollowUp: Boolean(followUp),
    });
    if (action === "images-not-queued") {
      toast.error("Images can't be queued. Attach them once the run ends.");
      // PromptInput keeps its attachments when submit throws.
      throw new Error("Images not queued");
    }
    if (action === "already-queued") {
      toast.error("A message is already queued. Edit or remove it first.");
    }
    if (action === "queue" && processingMessage) {
      if (contexts.length > 0) toast.info("Attachments stay in the box and aren't queued.");
      // The mode is read now: it's what the user picked for this message.
      setFollowUp(processingMessage.conversationId, {
        text: message.text,
        afterMessageId: processingMessage._id,
        mode: mode === "build" ? undefined : mode,
      });
      setInput("");
    }
    if (action !== "send") return;
    // One send at a time (the empty state's prompts bypass the disabled Send).
    if (pending) return;

    let finalMessage = message.text;
    if (contexts.length > 0) {
      const contextStrs = contexts.map(
        (c) => `File: ${c.fileName} (Lines ${c.startLine}-${c.endLine})\n\`\`\`\n${c.content}\n\`\`\``
      );
      // Leading /skill tokens stay first so the server still reads them.
      const { names, rest } = splitSlashSkills(finalMessage);
      const skills = names.map((name) => `/${name} `).join("");
      finalMessage = `${skills}${contextStrs.join("\n\n")}\n\n${rest}`;
    }

    setPending({
      text: finalMessage,
      imageUrls: message.files.map((file) => file.url),
      elements,
      userCount,
    });
    setInput("");
    let result: Awaited<ReturnType<typeof sendMessage>> = "blocked";
    try {
      let images: Id<"_storage">[] | undefined;
      if (message.files.length > 0) {
        images = await uploadMessageImages(message.files);
      }

      result = await sendMessage(
        finalMessage,
        images,
        mode === "build" ? undefined : mode,
        undefined,
        elements,
      );
      // Only clear contexts and elements after a successful send so they aren't lost on failure
      if (result === "sent") {
        clearContexts();
        clearElements();
      }
      // PromptInput keeps its attachments when submit throws, to send again.
      if (result !== "sent" && images) throw new Error("Message not sent");
    } finally {
      setPending(null);
      // An unsaved message goes back to the composer, unless a new one was started.
      if (result === "blocked" && !useChatStore.getState().input) {
        setInput(message.text);
      }
    }
  }

  /** Resends the prompt a reply answered, as-is, leaving the composer draft and contexts alone. */
  const resend = (messageIndex: number, mode?: MessageMode, model?: AgentModelChoice) => {
    const prompt = conversationMessages
      ?.slice(0, messageIndex)
      .findLast((m) => m.role === "user");
    if (prompt) void sendMessage(prompt.content, prompt.images, mode, model, prompt.elements);
  };

  /**
   * A stuck run's retry (#306): one tier up, on the run's key or the platform,
   * whichever served it, and only when that one offers the model.
   */
  const stuckRetry = (message: Doc<"messages">, messageIndex: number) => {
    const runModel = message.runModel;
    const next = runModel && nextTier(runModel.modelId);
    if (!next) return undefined;
    const key = runModel.keyId && modelKeys?.find((k) => k._id === runModel.keyId);
    const offered = runModel.keyId
      ? Boolean(key && modelIdsFor(key).includes(next.id))
      : platform.models.some((m) => m.id === next.id);
    if (!offered) return undefined;
    const choice = { ...(runModel.keyId ? { keyId: runModel.keyId } : {}), modelId: next.id };
    return {
      ...next,
      onRetry: () => {
        setAgentModel(choice);
        resend(messageIndex, message.mode, choice);
      },
    };
  };

  /** Throws (keeping the attachments) when the images can't be sent. */
  const uploadMessageImages = async (files: FileUIPart[]) => {
    if (!acceptsImages) {
      toast.error("This model can't read images. Pick a vision model to send them.");
      throw new Error("Model lacks vision");
    }
    try {
      return await uploadImages(files);
    } catch (error) {
      toast.error("Image upload failed");
      throw error;
    }
  };

  return (
    <>
      <PastConversationsDialog
        projectId={projectId}
        open={pastConversationsOpen}
        onOpenChange={setPastConversationsOpen}
        onSelect={setSelectedConversationId}
      />
      <CheckpointHistoryDialog
        checkpoints={checkpoints}
        open={checkpointHistoryOpen}
        onOpenChange={setCheckpointHistoryOpen}
        onRestore={(checkpoint) => {
          setCheckpointHistoryOpen(false);
          setRestoreTarget(checkpoint);
        }}
        disabled={isProcessing}
      />
      <RestoreCheckpointDialog
        checkpoint={restoreTarget}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
      />
      <div ref={panelRef} data-testid="chat-panel" className="@container flex flex-col h-full bg-sidebar">
        <div className="h-8.75 flex items-center justify-between border-b">
          <div className="text-sm font-medium truncate pl-3">
            {activeConversation?.title ?? DEFAULT_CONVERSATION_TITLE}
          </div>
          <div className={actionsInSheet ? "hidden @3xl/ide:flex items-center px-1 gap-1" : "flex items-center px-1 gap-1"}>
            <Button
              size="icon-xs"
              variant="highlight"
              aria-label="Version history"
              title="Version history"
              onClick={() => setCheckpointHistoryOpen(true)}
            >
              <ClockArrowUpIcon className="size-3.5" />
            </Button>
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
        {isEmpty && starters && !pending ? (
          <ChatEmptyState
            starters={starters}
            onSelect={(prompt) => void handleSubmit({ text: prompt, files: [] })}
          >
            {idOfPath.has(BRAND_FILE) && (
              <MakeItMineCard
                idOfPath={idOfPath}
                onDescribe={(prompt) => void handleSubmit({ text: prompt, files: [] })}
              />
            )}
          </ChatEmptyState>
        ) : (
        <Conversation className="flex-1">
          <ConversationContent className="gap-6 px-4 py-4 pb-12">
            {conversationMessages?.map((message, messageIndex) =>
              message.role === "user" ? (
                <UserMessage
                  key={message._id}
                  content={message.content}
                  imageUrls={message.imageUrls}
                  elements={message.elements}
                  skillNames={slashMenu.skillNames}
                  // The saved copy of the pending message replaces it in place.
                  animate={Boolean(history && !history.messageIds.has(message._id)) && !pending}
                  onRemember={
                    notes
                      ? () => {
                          setNoteDraft({ text: message.content.trim() });
                          dismissProposal(message._id);
                        }
                      : undefined
                  }
                  onDismissProposal={
                    notes &&
                    messageIndex === conversationMessages.length - 2 &&
                    (conversationMessages[messageIndex + 1].status ?? "completed") === "completed" &&
                    dismissedProposalId !== message._id &&
                    !isNoteProposalDismissed(projectId, message._id) &&
                    looksLikeLastingPreference(message.content, messageIndex > 0) &&
                    !notes.some((note) => note.text === message.content.trim())
                      ? () => dismissProposal(message._id)
                      : undefined
                  }
                />
              ) : (
                <AssistantMessage
                  key={message._id}
                  message={message}
                  isLast={messageIndex === conversationMessages.length - 1}
                  pathOf={pathOf}
                  onOpenFile={handleOpenFile}
                  onRetry={() => resend(messageIndex, message.mode)}
                  onBuildPlan={async (build) => {
                    setMode("build");
                    return (await sendMessage(build)) === "sent";
                  }}
                  stuckRetry={message.stuck && stuckRetry(message, messageIndex)}
                  onSuggestion={(line) => {
                    const { label, action } = parseSuggestion(line);
                    if (action && runSuggestionAction(action)) return;
                    setInput(label);
                    requestAnimationFrame(() => panelRef.current?.querySelector("textarea")?.focus());
                  }}
                  onDiagnose={() => {
                    if (!message.stuck) return;
                    setMode("plan");
                    // Added after any draft, not over it, then focused to review and send.
                    appendInput(diagnoseStuckMessage(message.stuck, stuckFilePath(message.stuck, pathOf)));
                    requestAnimationFrame(() => panelRef.current?.querySelector("textarea")?.focus());
                  }}
                  checkpointId={
                    checkpoints && (checkpointByMessage.get(message._id)?._id ?? null)
                  }
                  revertDisabled={isProcessing}
                  onRestore={
                    checkpointByMessage.has(message._id) && !isProcessing
                      ? () => setRestoreTarget(checkpointByMessage.get(message._id)!)
                      : undefined
                  }
                />
              ),
            )}
            {pending && userCount <= pending.userCount && (
              <UserMessage
                content={pending.text}
                imageUrls={pending.imageUrls}
                elements={pending.elements}
                skillNames={slashMenu.skillNames}
                animate
              />
            )}
          </ConversationContent>
          <ConversationScrollButton
            aria-label="Scroll to bottom"
            className="bottom-3 size-8 border-border bg-background/90 shadow-sm backdrop-blur transition-opacity duration-150 dark:bg-background/90"
          />
        </Conversation>
        )}
        <ProjectNoteDialog projectId={projectId} draft={noteDraft} onDraftChange={setNoteDraft} />
        <div className="chat-composer relative px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {/* Sits directly above the composer rather than inside the
              transcript: the agent is blocked waiting on this answer, and the
              message list can be scrolled away from the bottom, which would
              hide the prompt exactly when it matters. */}
          <ApprovalPrompt projectId={projectId} />
          {followUp && activeConversationId && (
            <QueuedFollowUp
              text={followUp.text}
              onEdit={() => {
                setFollowUp(activeConversationId, null);
                appendInput(followUp.text);
                panelRef.current?.querySelector("textarea")?.focus();
              }}
              onRemove={() => setFollowUp(activeConversationId, null)}
            />
          )}
          {/* Runs on the user's own key don't use credits. */}
          {!agentModel.keyId && <LowCreditsNotice />}
          {slashMenu.open && (
            <SkillSlashMenu
              items={slashMenu.items}
              activeName={slashMenu.activeName}
              onActiveChange={slashMenu.setActive}
              onSelect={slashMenu.select}
            />
          )}
          <PromptInput 
            onSubmit={handleSubmit}
            className="mt-2"
            accept={CHAT_IMAGE_TYPES.join(",")}
            multiple
            maxFiles={MAX_CHAT_IMAGES}
            maxFileSize={MAX_CHAT_IMAGE_BYTES}
            onError={({ code }) =>
              toast.error(
                code === "max_files"
                  ? `Attach up to ${MAX_CHAT_IMAGES} images per message.`
                  : `Images must be PNG, JPEG, WebP or GIF, up to ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB.`,
              )
            }
          >
            <PromptInputBody>
              <ComposerImages
                acceptsImages={acceptsImages}
                visionSwitch={visionSwitch}
                onSwitchModel={(choice) => {
                  setAgentModel(choice);
                  // The switch button unmounts; keep focus in the composer.
                  panelRef.current?.querySelector("textarea")?.focus();
                }}
              />
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
              <ElementChips
                elements={elements}
                onRemove={(index) => removeElement(elements[index].key)}
                className="w-full p-2 pb-0"
              />
              <PromptInputTextarea
                placeholder="Describe a change or ask a question…"
                className="min-h-11 px-3 pt-3 pb-1 text-sm/6 placeholder:text-muted-foreground/70"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(event) => {
                  if (
                    (isPlanModeKey(event.nativeEvent, event.currentTarget) ||
                      (event.code === "KeyM" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)) &&
                    !event.defaultPrevented && !event.nativeEvent.isComposing && !isProcessing && mode !== "swarm"
                  ) {
                    event.preventDefault();
                    setMode((current) => current === "plan" ? "build" : "plan");
                    return;
                  }
                  slashMenu.onKeyDown(event);
                }}
                value={input}
                disabled={enhancer.isEnhancing}
              />
            </PromptInputBody>
            <PromptInputFooter className="min-h-10 px-2 py-1">
              {/* The model name keeps its full width (flex-auto: basis auto) and wraps to its own row before it truncates (#217). */}
              <PromptInputTools className="min-w-0 flex-1 flex-wrap">
                <ComposerAttachButton disabled={isProcessing} />
                {!isProcessing && <PromptInputSpeechButton onTranscriptionChange={setInput} />}
                <EnhancePromptButton
                  enhancer={enhancer}
                  value={input}
                  disabled={isProcessing}
                />
                <PlanModeToggle
                  mode={mode}
                  onModeChange={setMode}
                  swarm={swarmEnabled}
                  disabled={isProcessing}
                />
                <AgentModelSelect
                  triggerClassName="min-w-16 flex-auto"
                  value={agentModel}
                  onValueChange={setAgentModel}
                  disabled={isProcessing}
                />
              </PromptInputTools>
              <div className="flex shrink-0 items-center gap-2">
                {/* Leave room for the picker when the mode labels appear. */}
                <span className="hidden items-center gap-1 text-[11px] text-muted-foreground @[640px]:inline-flex">
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
                {/* Its own button, not the form's submit, so Enter never stops a run (#257). */}
                {isProcessing && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        type="button"
                        variant="default"
                        size="icon-sm"
                        aria-label="Stop"
                        onClick={() => void handleCancel("button")}
                        className="size-8 rounded-lg"
                      >
                        <SquareIcon className="size-3 animate-in fill-current fade-in-0 zoom-in-75 duration-150 motion-reduce:animate-none" />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent>Stop (Esc twice)</TooltipContent>
                  </Tooltip>
                )}
                {(!isProcessing || input) && (
                <WithAttachmentCount>
                  {(images) => (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PromptInputSubmit
                        disabled={
                          isProcessing
                            ? Boolean(followUp)
                            : Boolean(pending) ||
                              enhancer.isEnhancing ||
                              (!input && contexts.length === 0 && elements.length === 0 && images === 0) ||
                              (images > 0 && !acceptsImages)
                        }
                        aria-label={isProcessing ? "Queue message" : "Send"}
                        className="size-8 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                      >
                        {/* Keyed so each swap pops the new icon in. */}
                        {isProcessing ? (
                          <ListEndIcon
                            key="queue"
                            className="size-4 animate-in fade-in-0 zoom-in-75 duration-150 motion-reduce:animate-none"
                          />
                        ) : (
                          <ArrowUpIcon
                            key="send"
                            className="size-4 animate-in fade-in-0 zoom-in-75 duration-150 motion-reduce:animate-none"
                          />
                        )}
                      </PromptInputSubmit>
                    </TooltipTrigger>
                    <TooltipContent>{isProcessing ? "Queue (Enter)" : "Send (Enter)"}</TooltipContent>
                  </Tooltip>
                  )}
                </WithAttachmentCount>
                )}
              </div>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </>
  );
};

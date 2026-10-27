import { useAuth } from "@clerk/expo";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { ImagePickerAsset } from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "expo-router/react-navigation";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { ChatComposer } from "@/components/chat-composer";
import { ChatEmptyState } from "@/components/chat-empty-state";
import { AssistantMessage, UserMessage, useRunStalled } from "@/components/chat-message";
import { GithubExportSheet } from "@/components/github-export-sheet";
import { ClockArrowUp, Download, ExternalLink, FolderTree, GitBranch, History, MoreHorizontal, Plug, Plus, Sparkles } from "@/components/icons";
import { Sheet, SheetRow } from "@/components/sheet";
import { useAgentModel } from "@/lib/agent-model";
import { api } from "@/lib/api";
import { useUploadChatImages } from "@/lib/chat-images";
import { timeAgo } from "@/lib/format";
import { postApi, webUrl } from "@/lib/http";
import { shareProjectZip } from "@/lib/project-zip";
import { PLAN_MODE, buildPathIndex, buildPlanMessage } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/** Same title the web gives a new conversation (DEFAULT_CONVERSATION_TITLE). */
const NEW_CONVERSATION_TITLE = "New conversation";

type MessageMode = typeof PLAN_MODE | undefined;

/** The export job's state, under "Export to GitHub" in the menu. */
const EXPORT_STATUS = {
  idle: undefined,
  exporting: "Exporting…",
  completed: "Exported",
  failed: "Export failed",
  cancelled: undefined,
};

/**
 * A project's chat, like the web's conversation panel: conversations (new,
 * past), version history, live run steps, and a composer with model, plan
 * mode, skills, images and enhance.
 */
export default function ProjectChat() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const { getToken } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id as Id<"projects">;

  const project = useQuery(api.projects.getById, { id: projectId });
  const conversations = useQuery(api.conversations.getByProject, { projectId });
  const [selectedId, setSelectedId] = useState<Id<"conversations">>();
  const conversationId = selectedId ?? conversations?.[0]?._id;
  const conversation = conversations?.find((item) => item._id === conversationId);
  const messages = useQuery(api.conversations.getMessages, conversationId ? { conversationId } : "skip");
  // The messages a conversation opened with: they are history and never
  // animate; anything that arrives later fades up (as on the web).
  const [history, setHistory] = useState<{ conversationId?: string; ids: Set<string> }>();
  if (messages && history?.conversationId !== conversationId) {
    setHistory({ conversationId, ids: new Set(messages.map((message) => message._id)) });
  }
  const files = useQuery(api.files.getFiles, { projectId });
  const checkpoints = useQuery(api.checkpoints.list, { projectId });
  const projectSkills = useQuery(api.skills.listProjectSkills, { projectId });
  const createConversation = useMutation(api.conversations.create);
  const restoreCheckpoint = useMutation(api.checkpoints.restore);
  const setSkillEnabled = useMutation(api.skills.setProjectSkillEnabled);
  const uploadImages = useUploadChatImages(projectId);
  const agent = useAgentModel();
  const convex = useConvex();

  const [planMode, setPlanMode] = useState(false);
  const [sheet, setSheet] = useState<"menu" | "conversations" | "versions" | "export" | "skills">();
  // Shown at once, until the request saves the real message (as on the web).
  const [pending, setPending] = useState<{ text: string; imageUrls: string[] }>();

  // File ids in agent text resolve to paths, as on the web; run chips carry
  // paths, so they open files through the reverse map.
  const { pathOf, idOfPath } = useMemo(() => {
    if (!files) return {};
    const pathOf = buildPathIndex(files);
    return { pathOf, idOfPath: new Map(files.map((file) => [pathOf(file._id), file._id])) };
  }, [files]);
  const openFile = (path: string) => {
    const fileId = idOfPath?.get(path);
    if (fileId) router.push({ pathname: "/projects/[id]/file", params: { id, fileId } });
  };

  const enabledSkills = useMemo(() => projectSkills?.filter((skill) => skill.enabled) ?? [], [projectSkills]);
  const skillNames = useMemo(() => new Set(enabledSkills.map((skill) => skill.name)), [enabledSkills]);
  const checkpointByMessage = useMemo(
    () => new Map(checkpoints?.map((checkpoint) => [checkpoint.messageId, checkpoint])),
    [checkpoints],
  );

  // A stalled run doesn't count: the composer offers Send (which clears it).
  const processing = messages?.findLast((message) => message.status === "processing");
  const stalled = useRunStalled(processing);
  const running = Boolean(processing) && !stalled;

  /** Sends to the active conversation, creating one first if there is none. */
  const sendMessage = async (text: string, images?: string[], mode?: MessageMode) => {
    const targetId = conversationId ?? (await createConversation({ projectId, title: NEW_CONVERSATION_TITLE }));
    setSelectedId(targetId);
    const { ok, data } = await postApi(
      "/api/messages",
      { conversationId: targetId, message: text, model: agent.model, images, mode },
      getToken,
    );
    return ok ? undefined : (data.error ?? "Message failed to send");
  };

  const send = async (text: string, images: ImagePickerAsset[]) => {
    setPending({ text, imageUrls: images.map((image) => image.uri) });
    try {
      const uploaded = images.length ? await uploadImages(images) : { ids: [] };
      if ("error" in uploaded) return uploaded.error;
      return await sendMessage(text, uploaded.ids.length ? uploaded.ids : undefined, planMode ? PLAN_MODE : undefined);
    } catch {
      return "Couldn't reach Codenaya. Is the server running?";
    } finally {
      setPending(undefined);
    }
  };

  const report = (error: string | undefined) => error && toast.error(error);
  const unreachable = () => toast.error("Couldn't reach Codenaya. Is the server running?");

  const stop = async () => {
    await postApi("/api/messages/cancel", { projectId }, getToken).catch(() => undefined);
  };

  const newConversation = async () => {
    setSheet(undefined);
    try {
      setSelectedId(await createConversation({ projectId, title: NEW_CONVERSATION_TITLE }));
    } catch {
      toast.error("Unable to create new conversation");
    }
  };

  const confirmRestore = async (checkpoint: { _id: Id<"checkpoints">; _creationTime: number }) => {
    setSheet(undefined);
    const confirmed = await confirm({
      title: "Restore to before this run?",
      message: `The project's files go back to how they were ${timeAgo(checkpoint._creationTime)}, before the agent ran. Changes made since then are replaced.`,
      confirmLabel: "Restore",
    });
    if (!confirmed) return;
    restoreCheckpoint({ checkpointId: checkpoint._id }).then(
      () => toast.success("Files restored"),
      () => toast.error("Couldn't restore the files"),
    );
  };

  if (project === undefined || conversations === undefined) {
    return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;
  }

  const ordered = [...(messages ?? [])].reverse();
  const lastId = messages?.at(-1)?._id;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android draws edge to edge, so the window no longer resizes for the
      // keyboard: pad on both platforms, below the header.
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          title: project.name,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => router.push({ pathname: "/projects/[id]/files", params: { id } })}
                hitSlop={10}
                accessibilityLabel="Files"
              >
                <FolderTree size={18} color={c.mutedForeground} />
              </Pressable>
              <Pressable onPress={() => setSheet("menu")} hitSlop={10} accessibilityLabel="Conversation menu">
                <MoreHorizontal size={20} color={c.mutedForeground} />
              </Pressable>
            </View>
          ),
        }}
      />
      <Text style={[styles.conversationTitle, { color: c.mutedForeground, borderColor: c.border }]} numberOfLines={1}>
        {conversation?.title ?? NEW_CONVERSATION_TITLE}
      </Text>

      {messages === undefined && conversationId ? (
        <ActivityIndicator style={styles.flex} color={c.mutedForeground} />
      ) : !messages?.length && !pending ? (
        <ChatEmptyState onSelect={(prompt) => send(prompt, []).then(report)} />
      ) : (
        <FlatList
          // Inverted: the newest message sits at the bottom and new steps keep
          // it in view without manual scrolling.
          inverted
          data={ordered}
          keyExtractor={(message) => message._id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          // The list is inverted, so its header sits below the newest message.
          ListHeaderComponent={
            pending && (
              <View style={styles.pending}>
                <UserMessage content={pending.text} imageUrls={pending.imageUrls} skillNames={skillNames} animate />
              </View>
            )
          }
          renderItem={({ item, index }) => {
            if (item.role === "user") {
              return (
                <UserMessage
                  content={item.content}
                  imageUrls={item.imageUrls}
                  skillNames={skillNames}
                  animate={Boolean(history && !history.ids.has(item._id)) && !pending}
                />
              );
            }
            const checkpoint = checkpointByMessage.get(item._id);
            return (
              <AssistantMessage
                message={item}
                isLast={item._id === lastId}
                pathOf={pathOf}
                onOpenFile={openFile}
                onRetry={() => {
                  // The prompt before this reply, resent as-is in the reply's mode.
                  const prompt = ordered.slice(index + 1).find((message) => message.role === "user");
                  if (prompt) sendMessage(prompt.content, prompt.images, item.mode).then(report, unreachable);
                }}
                onBuildPlan={() => {
                  setPlanMode(false);
                  sendMessage(buildPlanMessage(item.content)).then(report, unreachable);
                }}
                onRestore={checkpoint && !running ? () => confirmRestore(checkpoint) : undefined}
              />
            );
          }}
        />
      )}
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer
          running={running}
          agent={agent}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          skills={enabledSkills}
          onSend={send}
          onStop={stop}
        />
      </View>

      <Sheet visible={sheet === "menu"} title={project.name} onClose={() => setSheet(undefined)}>
        <SheetRow label="New conversation" trailing={<Plus size={16} color={c.mutedForeground} />} onPress={newConversation} />
        <SheetRow
          label="Past conversations"
          trailing={<History size={16} color={c.mutedForeground} />}
          onPress={() => setSheet("conversations")}
        />
        <SheetRow
          label="Version history"
          trailing={<ClockArrowUp size={16} color={c.mutedForeground} />}
          onPress={() => setSheet("versions")}
        />
        <SheetRow
          label="Skills"
          detail={`${enabledSkills.length} enabled`}
          trailing={<Sparkles size={16} color={c.mutedForeground} />}
          onPress={() => setSheet("skills")}
        />
        <SheetRow
          label="Integrations & env"
          detail="Connections and environment variables"
          trailing={<Plug size={16} color={c.mutedForeground} />}
          onPress={() => {
            setSheet(undefined);
            router.push({ pathname: "/projects/[id]/integrations", params: { id } });
          }}
        />
        <SheetRow
          label="Export to GitHub"
          detail={EXPORT_STATUS[project.exportStatus ?? "idle"]}
          trailing={<GitBranch size={16} color={c.mutedForeground} />}
          onPress={() => setSheet("export")}
        />
        <SheetRow
          label="Download ZIP"
          trailing={<Download size={16} color={c.mutedForeground} />}
          onPress={() => {
            setSheet(undefined);
            shareProjectZip(convex, projectId, project.name).catch(() => toast.error("Couldn't create the ZIP"));
          }}
        />
        <SheetRow
          label="Open on the website"
          detail="Live preview"
          trailing={<ExternalLink size={16} color={c.mutedForeground} />}
          onPress={() => {
            setSheet(undefined);
            WebBrowser.openBrowserAsync(webUrl(`/projects/${projectId}`));
          }}
        />
      </Sheet>

      <Sheet
        visible={sheet === "skills"}
        title="Skills"
        description="The agent sees enabled skills and loads one when a task matches. Manage your library in Settings."
        onClose={() => setSheet(undefined)}
      >
        {projectSkills?.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: c.mutedForeground }]}>No skills yet.</Text>
        )}
        {projectSkills?.map((skill) => (
          <SheetRow
            key={skill.key}
            label={skill.name}
            detail={skill.description}
            trailing={
              <Switch
                value={skill.enabled}
                onValueChange={(enabled) => {
                  setSkillEnabled({ projectId, skillKey: skill.key, enabled }).catch(() =>
                    toast.error(`Couldn't update ${skill.name}`),
                  );
                }}
                trackColor={{ true: c.brand }}
              />
            }
          />
        ))}
      </Sheet>

      <GithubExportSheet project={project} visible={sheet === "export"} onClose={() => setSheet(undefined)} />

      <Sheet visible={sheet === "conversations"} title="Past conversations" onClose={() => setSheet(undefined)}>
        {conversations.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: c.mutedForeground }]}>No conversations yet.</Text>
        )}
        {conversations.map((item) => (
          <SheetRow
            key={item._id}
            label={item.title}
            detail={timeAgo(item._creationTime)}
            selected={item._id === conversationId}
            onPress={() => {
              setSelectedId(item._id);
              setSheet(undefined);
            }}
          />
        ))}
      </Sheet>

      <Sheet
        visible={sheet === "versions"}
        title="Version history"
        description="A checkpoint is saved before each agent run. Restore one to undo the run and everything after it."
        onClose={() => setSheet(undefined)}
      >
        {checkpoints?.length === 0 && (
          <Text style={[styles.sheetEmpty, { color: c.mutedForeground }]}>No checkpoints yet.</Text>
        )}
        {checkpoints?.map((checkpoint) => (
          <SheetRow
            key={checkpoint._id}
            label={checkpoint.label || "Agent run"}
            detail={`${timeAgo(checkpoint._creationTime)} · ${checkpoint.fileCount} ${checkpoint.fileCount === 1 ? "file" : "files"}`}
            disabled={running}
            trailing={<Text style={[styles.restore, { color: c.brandText }]}>Restore</Text>}
            onPress={() => confirmRestore(checkpoint)}
          />
        ))}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 18 },
  conversationTitle: {
    fontSize: 12.5,
    fontFamily: font.medium,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  list: { padding: 16, gap: 18 },
  pending: { opacity: 0.6, marginTop: 18 },
  sheetEmpty: { textAlign: "center", paddingVertical: 24, fontSize: 14, fontFamily: font.regular },
  restore: { fontSize: 13, fontFamily: font.medium },
});

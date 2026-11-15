import { useAuth } from "@clerk/expo";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { ImagePickerAsset } from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { ChatComposer } from "@/components/chat-composer";
import { FilesPane } from "@/components/files-pane";
import { PreviewPane } from "@/components/preview-pane";
import { ChatEmptyState } from "@/components/chat-empty-state";
import { AssistantMessage, UserMessage, useRunStalled } from "@/components/chat-message";
import { GithubExportSheet } from "@/components/github-export-sheet";
import { GitHubIcon } from "@/components/github-icon";
import { DotGrid, HeaderFrame, monoLabel } from "@/components/grid";
import {
  ChevronDown,
  CodeXml,
  Download,
  ExternalLink,
  Eye,
  History,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Plug,
  Plus,
  Sparkles,
} from "@/components/icons";
import { Logo } from "@/components/logo";
import { Sheet, SheetRow } from "@/components/sheet";
import { UserAvatar } from "@/components/user-avatar";
import { useAgentModel } from "@/lib/agent-model";
import { api } from "@/lib/api";
import { useUploadChatImages } from "@/lib/chat-images";
import { useSandbox } from "@/lib/sandbox";
import { takeFirstMessage } from "@/lib/create-project";
import { timeAgo } from "@/lib/format";
import { postApi, webUrl } from "@/lib/http";
import { shareProjectZip } from "@/lib/project-zip";
import { PLAN_MODE, buildPathIndex, buildPlanMessage, hasRootPackageJson } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/** Same title the web gives a new conversation (DEFAULT_CONVERSATION_TITLE). */
const NEW_CONVERSATION_TITLE = "New conversation";

type MessageMode = typeof PLAN_MODE | "swarm" | undefined;

const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: "chat", label: "Chat", Icon: MessageSquare },
  { key: "code", label: "Code", Icon: CodeXml },
  { key: "preview", label: "Preview", Icon: Eye },
];
type Tab = "chat" | "code" | "preview";

/** The export job's state, under "Export to GitHub" in the menu. */
const EXPORT_STATUS = {
  idle: undefined,
  exporting: "Exporting…",
  completed: "Exported",
  failed: "Export failed",
  cancelled: undefined,
};

/**
 * A project, like the web's IDE in three tabs: the chat (conversations, version
 * history, live runs, and a composer with model, plan mode, skills, images and
 * enhance), the code, and the preview.
 */
export default function ProjectChat() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // ponytail: Reanimated's keyboard hook is deprecated; move to
  // react-native-keyboard-controller if it stops working.
  // Translucent bars: the app draws edge to edge, so the hook must not inset
  // the root view under the status bar (or turn edge to edge off on unmount).
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  // The screen ends at the keyboard while it is up; the tab bar clears the gesture bar.
  const bottom = useAnimatedStyle(() => ({ paddingBottom: keyboard.height.value }));
  const router = useRouter();
  const { getToken } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id as Id<"projects">;

  const project = useQuery(api.projects.getById, { id: projectId });
  const projects = useQuery(api.projects.get);
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
  const [typing, setTyping] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  // The sandbox boots the first time Preview opens, then runs until the project closes.
  const [previewOpened, setPreviewOpened] = useState(false);
  const previewFiles = useQuery(api.files.getFilesWithUrls, previewOpened ? { projectId } : "skip");
  const hasPackageJson = previewFiles && hasRootPackageJson(previewFiles);
  const sandbox = useSandbox({
    projectId,
    files: previewFiles,
    enabled: Boolean(hasPackageJson),
    settings: project?.settings,
  });
  const [sheet, setSheet] = useState<"menu" | "projects" | "conversations" | "versions" | "export" | "skills">();
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

  // A dashboard prompt with images: sent here, where images upload to the project.
  useEffect(() => {
    const first = takeFirstMessage(projectId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dispatch the pending prompt once when navigation opens the project
    if (first) send(first.text, first.images).then(report, unreachable);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the project opens
  }, [projectId]);

  const stop = async () => {
    const failed = () => toast.error("Couldn't stop the run. Try again.");
    await postApi("/api/messages/cancel", { projectId }, getToken).then(({ ok }) => !ok && failed(), failed);
  };

  const newConversation = async () => {
    try {
      setSelectedId(await createConversation({ projectId, title: NEW_CONVERSATION_TITLE }));
    } catch {
      toast.error("Couldn't create a new conversation. Try again.");
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
      () => toast.error("Couldn't restore the files. Your current files are unchanged."),
    );
  };

  if (project === undefined || conversations === undefined) {
    return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;
  }

  const ordered = [...(messages ?? [])].reverse();
  const lastId = messages?.at(-1)?._id;

  return (
    <Animated.View style={[styles.flex, bottom]}>
      <Stack.Screen
        options={{
          // The project's own header cells: logo, name (switches project), menu, account.
          header: () => (
            <HeaderFrame>
              <HeaderCell label="Dashboard" onPress={() => router.dismissTo("/")} edge="right">
                <Logo size={22} wordmark={false} />
              </HeaderCell>
              <Pressable
                onPress={() => setSheet("projects")}
                accessibilityLabel="Switch project"
                style={({ pressed }) => [styles.nameCell, pressed && { backgroundColor: c.muted }]}
              >
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {project.name}
                </Text>
                <ChevronDown size={16} color={c.mutedForeground} />
              </Pressable>
              <HeaderCell label="Project menu" onPress={() => setSheet("menu")}>
                <MoreHorizontal size={20} color={c.foreground} />
              </HeaderCell>
              <HeaderCell label="Settings" onPress={() => router.push("/settings")} wide>
                <UserAvatar size={32} />
              </HeaderCell>
            </HeaderFrame>
          ),
        }}
      />

      {tab === "chat" ? (
        <>
          {/* The chat's strip: the conversation's title, version history, past conversations and a new one. */}
          <View style={[styles.strip, { borderColor: c.border }]}>
            <View style={[styles.bar, { backgroundColor: c.brand }]} />
            <Text style={[styles.conversationTitle, { color: c.foreground }]} numberOfLines={1}>
              {conversation?.title ?? NEW_CONVERSATION_TITLE}
            </Text>
            <StripCell label="Version history" onPress={() => setSheet("versions")}>
              <History size={17} color={c.foreground} />
            </StripCell>
            <StripCell label="Past conversations" onPress={() => setSheet("conversations")}>
              <MessagesSquare size={17} color={c.foreground} />
            </StripCell>
            <StripCell label="New conversation" onPress={newConversation} wide>
              <Plus size={16} color={c.foreground} />
              <Text style={[monoLabel, { color: c.foreground }]}>New</Text>
            </StripCell>
          </View>

          <View style={styles.flex}>
            <DotGrid />
            {messages === undefined && conversationId ? (
              <ActivityIndicator style={styles.flex} color={c.mutedForeground} />
            ) : !messages?.length && !pending ? (
              <ChatEmptyState typing={typing} onSelect={(prompt) => send(prompt, []).then(report)} />
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
                        time={item._creationTime}
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
          </View>
          <View style={{ backgroundColor: c.background }}>
            <ChatComposer
              running={running}
              agent={agent}
              planMode={planMode}
              onPlanModeChange={setPlanMode}
              skills={enabledSkills}
              onSend={send}
              onStop={stop}
              onFocusChange={setTyping}
            />
          </View>
        </>
      ) : tab === "code" ? (
        <FilesPane projectId={projectId} />
      ) : (
        <PreviewPane sandbox={sandbox} hasPackageJson={hasPackageJson} />
      )}

      {/* Chat, Code and Preview; hidden while typing, so the composer sits on the keyboard. */}
      {!typing && (
        <View style={[styles.tabs, { borderColor: c.border, paddingBottom: insets.bottom }]}>
          {TABS.map(({ key, label, Icon }, index) => {
            const active = tab === key;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setTab(key);
                  if (key === "preview") setPreviewOpened(true);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[
                  styles.tab,
                  { backgroundColor: active ? c.card : c.background, borderColor: c.border },
                  index > 0 && styles.tabDivider,
                ]}
              >
                <View style={[styles.tabMark, { backgroundColor: active ? c.brand : "transparent" }]} />
                <Icon size={18} color={active ? c.foreground : c.mutedForeground} />
                <Text style={[monoLabel, { color: active ? c.foreground : c.mutedForeground }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Sheet visible={sheet === "menu"} title={project.name} onClose={() => setSheet(undefined)}>
        <SheetRow
          label="Skills"
          detail={`${enabledSkills.length} enabled`}
          icon={<Sparkles size={16} color={c.foreground} />}
          onPress={() => setSheet("skills")}
        />
        <SheetRow
          label="Integrations & env"
          detail="Connections and environment variables"
          icon={<Plug size={16} color={c.foreground} />}
          onPress={() => {
            setSheet(undefined);
            router.push({ pathname: "/projects/[id]/integrations", params: { id } });
          }}
        />
        <SheetRow
          label="Export to GitHub"
          detail={EXPORT_STATUS[project.exportStatus ?? "idle"]}
          icon={<GitHubIcon size={16} color={c.foreground} />}
          onPress={() => setSheet("export")}
        />
        <SheetRow
          label="Download ZIP"
          icon={<Download size={16} color={c.foreground} />}
          onPress={() => {
            setSheet(undefined);
            shareProjectZip(convex, projectId, project.name).catch(() =>
              toast.error("Couldn't create the ZIP. Try again."),
            );
          }}
        />
        <SheetRow
          label="Open on the website"
          detail="Live preview"
          icon={<ExternalLink size={16} color={c.foreground} />}
          onPress={() => {
            setSheet(undefined);
            WebBrowser.openBrowserAsync(webUrl(`/projects/${projectId}`));
          }}
        />
      </Sheet>

      <Sheet visible={sheet === "projects"} title="Projects" onClose={() => setSheet(undefined)}>
        {[...(projects ?? [])]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((item) => (
            <SheetRow
              key={item._id}
              label={item.name}
              detail={timeAgo(item.updatedAt)}
              selected={item._id === projectId}
              onPress={() => {
                setSheet(undefined);
                if (item._id !== projectId) router.replace({ pathname: "/projects/[id]", params: { id: item._id } });
              }}
            />
          ))}
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
        {/* A timeline, newest first: the latest checkpoint gets the orange dot. */}
        {checkpoints?.map((checkpoint, index) => {
          const latest = index === 0;
          const last = index === checkpoints.length - 1;
          return (
            <Pressable
              key={checkpoint._id}
              disabled={running}
              onPress={() => confirmRestore(checkpoint)}
              accessibilityLabel={`Restore to before ${checkpoint.label || "this agent run"}`}
              style={({ pressed }) => [
                styles.version,
                { borderColor: c.border },
                pressed && { backgroundColor: c.muted },
                running && styles.dim,
              ]}
            >
              <View style={styles.rail}>
                <View
                  style={[styles.railLine, { backgroundColor: c.border, top: latest ? "50%" : 0, bottom: last ? "50%" : 0 }]}
                />
                <View
                  style={[
                    styles.railDot,
                    latest
                      ? { backgroundColor: c.brand, borderColor: c.brand }
                      : { backgroundColor: c.card, borderColor: c.mutedForeground },
                  ]}
                />
              </View>
              <View style={styles.flex}>
                <Text style={[styles.versionLabel, { color: c.foreground }]} numberOfLines={1}>
                  {checkpoint.label || "Agent run"}
                </Text>
                <Text style={[monoLabel, styles.versionMeta, { color: c.mutedForeground }]} numberOfLines={1}>
                  Before run · {timeAgo(checkpoint._creationTime)} · {checkpoint.fileCount}{" "}
                  {checkpoint.fileCount === 1 ? "file" : "files"}
                </Text>
              </View>
              {latest ? (
                <Text style={[monoLabel, styles.latest, { color: c.brandText, borderColor: `${c.brand}88` }]}>Latest</Text>
              ) : (
                <View style={[styles.restore, { borderColor: c.border }]}>
                  <Text style={[monoLabel, { color: c.foreground }]}>Restore</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </Sheet>
    </Animated.View>
  );
}

/** A square header cell: an icon or the avatar, split off by a rule. */
function HeaderCell({
  label,
  onPress,
  edge = "left",
  wide,
  children,
}: {
  label: string;
  onPress: () => void;
  edge?: "left" | "right";
  wide?: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.headerCell,
        wide && styles.wideCell,
        edge === "left" ? styles.ruleLeft : styles.ruleRight,
        { borderColor: c.border },
        pressed && { backgroundColor: c.muted },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** A cell on the chat's strip, split off by a rule. */
function StripCell({ label, onPress, wide, children }: { label: string; onPress: () => void; wide?: boolean; children: ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.stripCell,
        wide && styles.stripWide,
        { borderColor: c.border },
        pressed && { backgroundColor: c.muted },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerCell: { width: 44, alignItems: "center", justifyContent: "center" },
  wideCell: { width: 52 },
  ruleLeft: { borderLeftWidth: 1 },
  ruleRight: { borderRightWidth: 1 },
  nameCell: { flex: 1, height: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
  name: { flexShrink: 1, fontSize: 17, letterSpacing: -0.2, fontFamily: font.medium },
  // No gap: it would sit inside each cell's rule and push its icon off centre.
  strip: { height: 40, flexDirection: "row", alignItems: "center", paddingLeft: 16, borderBottomWidth: 1 },
  stripCell: { width: 44, alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderLeftWidth: 1 },
  stripWide: { width: undefined, paddingHorizontal: 16 },
  bar: { width: 2, height: 12 },
  conversationTitle: { flex: 1, fontSize: 14, fontFamily: font.medium, marginLeft: 10, marginRight: 12 },
  tabs: { flexDirection: "row", borderTopWidth: 1 },
  tab: { flex: 1, height: 56, alignItems: "center", justifyContent: "center", gap: 4 },
  tabDivider: { borderLeftWidth: 1 },
  // The active tab's orange rule along its top edge.
  tabMark: { position: "absolute", top: -1, left: 0, right: 0, height: 2 },
  list: { padding: 16, gap: 24 },
  pending: { opacity: 0.6, marginTop: 18 },
  sheetEmpty: { textAlign: "center", paddingVertical: 24, fontSize: 14, fontFamily: font.regular },
  restore: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8 },
  dim: { opacity: 0.5 },
  // Full-bleed across the sheet body's padding, like SheetRow.
  version: { flexDirection: "row", alignItems: "center", gap: 14, marginHorizontal: -8, paddingRight: 16, borderBottomWidth: 1 },
  rail: { width: 40, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  railLine: { position: "absolute", width: 1, left: 19.5 },
  railDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  versionLabel: { fontSize: 15, fontFamily: font.regular, marginTop: 14 },
  versionMeta: { marginTop: 4, marginBottom: 14 },
  latest: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
});

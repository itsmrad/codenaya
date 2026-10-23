import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { FolderTree } from "lucide-react-native";
import { useMemo } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { ChatComposer } from "@/components/chat-composer";
import { AssistantMessage, UserMessage } from "@/components/chat-message";
import { api } from "@/lib/api";
import { postApi } from "@/lib/http";
import { buildPathIndex } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/** Same title the web gives a new conversation (DEFAULT_CONVERSATION_TITLE). */
const NEW_CONVERSATION_TITLE = "New conversation";

/**
 * A project's chat, like the web's conversation panel: the latest
 * conversation, live run steps, and a box to send or stop.
 */
export default function ProjectChat() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { getToken } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id as Id<"projects">;

  const project = useQuery(api.projects.getById, { id: projectId });
  const conversations = useQuery(api.conversations.getByProject, { projectId });
  const conversationId = conversations?.[0]?._id;
  const messages = useQuery(api.conversations.getMessages, conversationId ? { conversationId } : "skip");
  const files = useQuery(api.files.getFiles, { projectId });
  const createConversation = useMutation(api.conversations.create);

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
  const running = messages?.some((message) => message.status === "processing") ?? false;

  const send = async (text: string) => {
    try {
      const targetId =
        conversationId ?? (await createConversation({ projectId, title: NEW_CONVERSATION_TITLE }));
      const { ok, data } = await postApi("/api/messages", { conversationId: targetId, message: text }, getToken);
      return ok ? undefined : (data.error ?? "Message failed to send");
    } catch {
      return "Couldn't reach Codenaya. Is the server running?";
    }
  };

  const stop = async () => {
    await postApi("/api/messages/cancel", { projectId }, getToken).catch(() => undefined);
  };

  if (project === undefined || conversations === undefined) {
    return <ActivityIndicator style={styles.flex} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
    >
      <Stack.Screen
        options={{
          title: project.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push({ pathname: "/projects/[id]/files", params: { id } })}
              hitSlop={10}
              accessibilityLabel="Files"
            >
              <FolderTree size={18} color={c.mutedForeground} />
            </Pressable>
          ),
        }}
      />
      {messages === undefined && conversationId ? (
        <ActivityIndicator style={styles.flex} />
      ) : !messages?.length ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
            Ask Codenaya to build or change something in {project.name}.
          </Text>
        </View>
      ) : (
        <FlatList
          // Inverted: the newest message sits at the bottom and new steps keep
          // it in view without manual scrolling.
          inverted
          data={[...messages].reverse()}
          keyExtractor={(message) => message._id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) =>
            item.role === "user" ? (
              <UserMessage content={item.content} />
            ) : (
              <AssistantMessage message={item} pathOf={pathOf} onOpenFile={openFile} />
            )
          }
        />
      )}
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer running={running} onSend={send} onStop={stop} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 18 },
  empty: { flex: 1, justifyContent: "center", padding: 24 },
  emptyText: { textAlign: "center", fontSize: 14, fontFamily: font.regular },
});

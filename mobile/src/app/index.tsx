import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack } from "expo-router";
import { LogOut } from "lucide-react-native";
import { useEffect } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { ProjectCard } from "@/components/project-card";
import { PromptComposer } from "@/components/prompt-composer";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

export default function Dashboard() {
  const c = useColors();
  const { signOut } = useAuth();
  const projects = useQuery(api.projects.get);
  const ensureCurrent = useMutation(api.users.ensureCurrent);

  // Same as the web's useEnsureCurrentUser: creates the user row if Clerk's
  // webhook has not arrived yet. Idempotent on the server.
  useEffect(() => {
    ensureCurrent().catch((error: unknown) => console.error("Failed to sync the user", error));
  }, [ensureCurrent]);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => signOut()} hitSlop={10} accessibilityLabel="Sign out">
              <LogOut size={18} color={c.mutedForeground} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={projects ?? []}
        keyExtractor={(project) => project._id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.hero}>
            <Text style={[styles.title, { color: c.foreground }]}>What will you build?</Text>
            <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
              Describe an app and Codenaya writes it for you.
            </Text>
            <PromptComposer />
            <Text style={[styles.section, { color: c.foreground }]}>Your projects</Text>
          </View>
        }
        ListEmptyComponent={
          projects === undefined ? (
            <ActivityIndicator style={styles.empty} />
          ) : (
            <Text style={[styles.empty, styles.emptyText, { color: c.mutedForeground }]}>
              No projects yet. Describe one above to start.
            </Text>
          )
        }
        renderItem={({ item }) => <ProjectCard project={item} />}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 14, paddingBottom: 48 },
  hero: { gap: 10, paddingTop: 12 },
  title: { fontSize: 30, letterSpacing: -0.6, fontFamily: font.semibold, textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: font.regular, textAlign: "center", marginBottom: 14 },
  section: { fontSize: 15, fontFamily: font.semibold, marginTop: 22 },
  empty: { marginTop: 32 },
  emptyText: { textAlign: "center", fontSize: 14, fontFamily: font.regular },
});

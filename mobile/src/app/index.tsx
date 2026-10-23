import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack } from "expo-router";
import { ArrowUpDown, LogOut, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { Doc } from "../../../convex/_generated/dataModel";

import { ProjectCard } from "@/components/project-card";
import { FirstRunChecklist } from "@/components/first-run-checklist";
import { PromptComposer } from "@/components/prompt-composer";
import { StarterTemplates } from "@/components/starter-templates";
import { api } from "@/lib/api";
import { font, radius, useColors } from "@/lib/theme";

// The web grid's sorts (projects-grid.tsx).
const SORTS = {
  updated: { label: "Last edited", compare: (a: Doc<"projects">, b: Doc<"projects">) => b.updatedAt - a.updatedAt },
  created: { label: "Newest", compare: (a: Doc<"projects">, b: Doc<"projects">) => b._creationTime - a._creationTime },
  name: { label: "Name", compare: (a: Doc<"projects">, b: Doc<"projects">) => a.name.localeCompare(b.name) },
};
type SortKey = keyof typeof SORTS;
const SORT_ORDER = Object.keys(SORTS) as SortKey[];

export default function Dashboard() {
  const c = useColors();
  const { signOut } = useAuth();
  const projects = useQuery(api.projects.get);
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const visible = (projects ?? [])
    .filter((project) => project.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(SORTS[sort].compare);

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
        data={visible}
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
            {projects && <FirstRunChecklist projects={projects} />}
            <StarterTemplates />
            <View style={styles.sectionRow}>
              <Text style={[styles.section, { color: c.foreground }]}>Your projects</Text>
              {projects && <Text style={[styles.count, { color: c.mutedForeground }]}>{projects.length}</Text>}
            </View>
            {projects && projects.length > 0 && (
              <View style={styles.tools}>
                <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
                  <Search size={14} color={c.mutedForeground} />
                  <TextInput
                    style={[styles.searchInput, { color: c.foreground }]}
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search projects"
                    placeholderTextColor={c.mutedForeground}
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                  />
                </View>
                <Pressable
                  // Cycles Last edited → Newest → Name, like picking from the web's menu.
                  onPress={() => setSort(SORT_ORDER[(SORT_ORDER.indexOf(sort) + 1) % SORT_ORDER.length])}
                  accessibilityLabel={`Sort: ${SORTS[sort].label}`}
                  style={[styles.sort, { backgroundColor: c.card, borderColor: c.border }]}
                >
                  <ArrowUpDown size={14} color={c.mutedForeground} />
                  <Text style={[styles.sortText, { color: c.mutedForeground }]}>{SORTS[sort].label}</Text>
                </Pressable>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          projects === undefined ? (
            <ActivityIndicator style={styles.empty} />
          ) : (
            <Text style={[styles.empty, styles.emptyText, { color: c.mutedForeground }]}>
              {query ? `No projects match "${query.trim()}".` : "No projects yet. Describe one above to start."}
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
  sectionRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 22 },
  section: { fontSize: 15, fontFamily: font.semibold },
  count: { fontSize: 12, fontFamily: font.regular },
  tools: { flexDirection: "row", gap: 8 },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 36,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
  },
  searchInput: { flex: 1, fontSize: 13, fontFamily: font.regular, paddingVertical: 0 },
  sort: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
  },
  sortText: { fontSize: 12, fontFamily: font.regular },
  empty: { marginTop: 32 },
  emptyText: { textAlign: "center", fontSize: 14, fontFamily: font.regular },
});

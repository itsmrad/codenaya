import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { ArrowUpDown, GitBranch, Search, Settings } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Doc } from "../../../convex/_generated/dataModel";

import { ProjectCard } from "@/components/project-card";
import { FirstRunChecklist } from "@/components/first-run-checklist";
import { NameDialog } from "@/components/name-dialog";
import { PromptComposer } from "@/components/prompt-composer";
import { StarterTemplates } from "@/components/starter-templates";
import { api } from "@/lib/api";
import { GITHUB_NOT_LINKED, alertGithubNotLinked } from "@/lib/github";
import { postApi } from "@/lib/http";
import { PULSE, fadeUp } from "@/lib/motion";
import { parseGithubRepo } from "@/lib/shared";
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
  const { getToken } = useAuth();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const projects = useQuery(api.projects.get);
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [importOpen, setImportOpen] = useState(false);
  const visible = (projects ?? [])
    .filter((project) => project.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(SORTS[sort].compare);

  /** Like the web's ImportGithubDialog: a new project, filled by the import job. */
  const importRepo = async (input: string) => {
    const slug = parseGithubRepo(input);
    if (!slug) throw new Error("Enter a GitHub repository URL like https://github.com/owner/repo");
    const { ok, data } = await postApi<{ projectId: string }>(
      "/api/github/import",
      { url: `https://github.com/${slug}` },
      getToken,
    );
    if (data.code === GITHUB_NOT_LINKED) {
      return alertGithubNotLinked(
        "This repository is private or doesn't exist. Public repositories import without GitHub; connect GitHub to import private ones.",
      );
    }
    if (!ok) throw new Error(data.error ?? "Unable to import repository. Please check the URL and try again");
    router.push(`/projects/${data.projectId}`);
  };

  // Same as the web's useEnsureCurrentUser: creates the user row if Clerk's
  // webhook has not arrived yet. Idempotent on the server.
  useEffect(() => {
    ensureCurrent().catch((error: unknown) => console.error("Failed to sync the user", error));
  }, [ensureCurrent]);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push("/settings")} hitSlop={10} accessibilityLabel="Settings">
              <Settings size={19} color={c.mutedForeground} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={visible}
        keyExtractor={(project) => project._id}
        // Clear of Android's gesture bar, which the list draws behind.
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 48 }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          // The web dashboard's entry: heading, then the composer, then the rest.
          <View style={styles.hero}>
            <Animated.View entering={fadeUp({ rise: 12, duration: 500 })}>
              <Text style={[styles.title, { color: c.foreground }]}>What will you build?</Text>
              <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
                Describe an app and Codenaya writes it for you.
              </Text>
            </Animated.View>
            <Animated.View entering={fadeUp({ rise: 12, duration: 500, delay: 100 })}>
              <PromptComposer />
            </Animated.View>
            <Animated.View entering={fadeUp({ rise: 0, duration: 500, delay: 200 })} style={styles.group}>
              {projects && <FirstRunChecklist projects={projects} />}
              <StarterTemplates />
              <View style={styles.sectionRow}>
                <Text style={[styles.section, { color: c.foreground }]}>Your projects</Text>
                {projects && <Text style={[styles.count, { color: c.mutedForeground }]}>{projects.length}</Text>}
                <Pressable
                  onPress={() => setImportOpen(true)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.import, pressed && { opacity: 0.6 }]}
                >
                  <GitBranch size={14} color={c.mutedForeground} />
                  <Text style={[styles.sortText, { color: c.mutedForeground }]}>Import from GitHub</Text>
                </Pressable>
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
            </Animated.View>
          </View>
        }
        ListEmptyComponent={
          projects === undefined ? (
            // The web grid's pulsing placeholders while projects load.
            <View style={styles.skeletons}>
              {[0, 1].map((index) => (
                <Animated.View key={index} style={[styles.skeleton, { backgroundColor: c.muted }, PULSE]} />
              ))}
            </View>
          ) : (
            <Text style={[styles.empty, styles.emptyText, { color: c.mutedForeground }]}>
              {query ? `No projects match "${query.trim()}".` : "No projects yet. Describe one above to start."}
            </Text>
          )
        }
        // Cards rise in one after another, like the web grid.
        renderItem={({ item, index }) => (
          <Animated.View entering={fadeUp({ rise: 8, duration: 250, delay: Math.min(index * 40, 300) })}>
            <ProjectCard project={item} />
          </Animated.View>
        )}
      />
      <NameDialog
        visible={importOpen}
        title="Import from GitHub"
        placeholder="https://github.com/owner/repo"
        confirmLabel="Import"
        onClose={() => setImportOpen(false)}
        onSave={importRepo}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 14 },
  hero: { gap: 10, paddingTop: 12 },
  group: { gap: 10 },
  title: { fontSize: 30, letterSpacing: -0.6, fontFamily: font.semibold, textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: font.regular, textAlign: "center", marginBottom: 14 },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22 },
  section: { fontSize: 15, fontFamily: font.semibold },
  count: { fontSize: 12, fontFamily: font.regular },
  import: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
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
  skeletons: { gap: 14 },
  skeleton: { aspectRatio: 16 / 12.5, borderRadius: radius.xl },
  emptyText: { textAlign: "center", fontSize: 14, fontFamily: font.regular },
});

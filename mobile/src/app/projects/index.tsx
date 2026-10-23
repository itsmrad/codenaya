import { useAuth } from "@clerk/expo";
import { useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { ArrowUpDown, GitBranch, Search } from "lucide-react-native";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Doc } from "../../../../convex/_generated/dataModel";
import { NameDialog } from "@/components/name-dialog";
import { ProjectCard } from "@/components/project-card";
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

/** Every project, like the web grid's "Show all": search, sort and Import from GitHub. */
export default function AllProjects() {
  const c = useColors();
  const { getToken } = useAuth();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const projects = useQuery(api.projects.get);
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

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          title: projects ? `All projects (${projects.length})` : "All projects",
          headerRight: () => (
            <Pressable onPress={() => setImportOpen(true)} hitSlop={10} accessibilityLabel="Import from GitHub">
              <GitBranch size={19} color={c.mutedForeground} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={visible}
        keyExtractor={(project) => project._id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
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
        }
        ListEmptyComponent={
          projects === undefined ? (
            <View style={styles.skeletons}>
              {[0, 1, 2].map((index) => (
                <Animated.View key={index} style={[styles.skeleton, { backgroundColor: c.muted }, PULSE]} />
              ))}
            </View>
          ) : (
            <Text style={[styles.empty, { color: c.mutedForeground }]}>
              {query ? `No projects match "${query.trim()}".` : "No projects yet."}
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
  list: { padding: 16, gap: 12 },
  tools: { flexDirection: "row", gap: 8, marginBottom: 2 },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: font.regular, paddingVertical: 0 },
  sort: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 38,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 10,
  },
  sortText: { fontSize: 12, fontFamily: font.regular },
  skeletons: { gap: 12 },
  skeleton: { height: 52, borderRadius: radius.xl },
  empty: { marginTop: 32, textAlign: "center", fontSize: 14, fontFamily: font.regular },
});

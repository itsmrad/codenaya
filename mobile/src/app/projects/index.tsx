import { useAuth } from "@clerk/expo";
import { useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Doc } from "../../../../convex/_generated/dataModel";
import { Button, Field } from "@/components/form";
import { monoLabel } from "@/components/grid";
import { GitHubIcon } from "@/components/github-icon";
import { ArrowUpDown, Download, Search } from "@/components/icons";
import { ProjectCard } from "@/components/project-card";
import { Sheet } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { GITHUB_NOT_LINKED, alertGithubNotLinked } from "@/lib/github";
import { postApi } from "@/lib/http";
import { PULSE, fadeUp } from "@/lib/motion";
import { parseGithubRepo } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

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
  const [repo, setRepo] = useState("");
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);
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

  const submitImport = async () => {
    setImporting(true);
    setImportError(undefined);
    try {
      await importRepo(repo);
      setImportOpen(false);
      setRepo("");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          title: "All projects",
          headerRight: () => (
            <Pressable
              onPress={() => setImportOpen(true)}
              hitSlop={10}
              accessibilityLabel="Import from GitHub"
              style={styles.import}
            >
              <GitHubIcon size={15} color={c.foreground} />
              <Text style={[monoLabel, { color: c.foreground }]}>Import</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={visible}
        keyExtractor={(project) => project._id}
        style={{ backgroundColor: c.card }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <View style={[styles.tools, { borderColor: c.border }]}>
              <View style={styles.search}>
                <Search size={16} color={c.mutedForeground} />
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
                style={({ pressed }) => [styles.sort, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
              >
                <ArrowUpDown size={14} color={c.mutedForeground} />
                <Text style={[monoLabel, { color: c.mutedForeground }]}>{SORTS[sort].label}</Text>
              </Pressable>
            </View>
            {projects !== undefined && (
              <View style={[styles.count, { borderColor: c.border, backgroundColor: c.background }]}>
                <Text style={[monoLabel, { color: c.mutedForeground }]}>
                  {visible.length} {visible.length === 1 ? "project" : "projects"}
                </Text>
                <Text style={[monoLabel, { color: c.mutedForeground }]}>Sorted · {SORTS[sort].label}</Text>
              </View>
            )}
          </>
        }
        ListEmptyComponent={
          projects === undefined ? (
            <View>
              {[0, 1, 2].map((index) => (
                <View key={index} style={[styles.skeletonRow, { borderColor: c.border }]}>
                  <Animated.View style={[styles.skeleton, { backgroundColor: c.muted }, PULSE]} />
                </View>
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
          <Animated.View
            entering={fadeUp({ rise: 8, duration: 250, delay: Math.min(index * 40, 300) })}
            style={[styles.item, { borderColor: c.border }]}
          >
            <ProjectCard project={item} />
          </Animated.View>
        )}
      />
      <Sheet
        visible={importOpen}
        title="Import from GitHub"
        description="Enter a GitHub repository URL like https://github.com/owner/repo"
        onClose={() => setImportOpen(false)}
      >
        <View style={styles.form}>
          <Field
            label="Repository"
            value={repo}
            onChangeText={setRepo}
            onSubmitEditing={submitImport}
            placeholder="https://github.com/owner/repo"
            keyboardType="url"
            autoFocus
            hint="Public repositories import without GitHub; connect GitHub to import private ones."
          />
          {importError && <Text style={[styles.error, { color: c.destructive }]}>{importError}</Text>}
          <Button
            label="Import"
            variant="brand"
            icon={<Download size={14} color={c.brandForeground} />}
            busy={importing}
            disabled={!repo.trim()}
            onPress={submitImport}
          />
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  import: { flexDirection: "row", alignItems: "center", gap: 8, height: 48, paddingHorizontal: 16 },
  // Full-bleed cells on the grid: search, then the sort, split by a rule.
  tools: { flexDirection: "row", height: 48, borderBottomWidth: 1 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  searchInput: { flex: 1, fontSize: 15, fontFamily: font.regular, paddingVertical: 0 },
  sort: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, borderLeftWidth: 1 },
  count: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  item: { borderBottomWidth: 1 },
  skeletonRow: { padding: 12, paddingHorizontal: 16, borderBottomWidth: 1 },
  skeleton: { height: 44, borderRadius: 4 },
  empty: { marginTop: 32, textAlign: "center", fontSize: 14, fontFamily: font.regular },
  form: { gap: 14, paddingHorizontal: 8, paddingTop: 4 },
  error: { fontSize: 13, fontFamily: font.regular },
});

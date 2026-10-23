import { useMutation, useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { ChevronRight, Settings } from "lucide-react-native";
import { Fragment, useEffect } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FirstRunChecklist } from "@/components/first-run-checklist";
import { ProjectCard } from "@/components/project-card";
import { PromptComposer } from "@/components/prompt-composer";
import { StarterTemplates } from "@/components/starter-templates";
import { api } from "@/lib/api";
import { PULSE, fadeUp } from "@/lib/motion";
import { font, radius, useColors } from "@/lib/theme";

/** Projects shown on the dashboard; the rest are one tap away under "See all". */
const RECENT_COUNT = 3;

export default function Dashboard() {
  const c = useColors();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const projects = useQuery(api.projects.get);
  const ensureCurrent = useMutation(api.users.ensureCurrent);
  const recent = [...(projects ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT);

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
      <ScrollView
        // Clear of Android's gesture bar, which the page draws behind.
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 48 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* The web dashboard's entry: heading, then the composer, then the rest. */}
        <Animated.View entering={fadeUp({ rise: 12, duration: 500 })}>
          <Text style={[styles.title, { color: c.foreground }]}>What will you build?</Text>
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
            Describe an app and Codenaya writes it for you.
          </Text>
        </Animated.View>
        <Animated.View entering={fadeUp({ rise: 12, duration: 500, delay: 100 })}>
          <PromptComposer />
        </Animated.View>
        <Animated.View entering={fadeUp({ rise: 0, duration: 500, delay: 200 })}>
          {projects && <FirstRunChecklist projects={projects} />}

          <View style={styles.sectionRow}>
            <Text style={[styles.section, { color: c.foreground }]}>Your projects</Text>
            {projects && projects.length > 0 && (
              <Pressable
                onPress={() => router.push("/projects")}
                hitSlop={8}
                accessibilityLabel="See all projects"
                style={({ pressed }) => [styles.seeAll, pressed && styles.dim]}
              >
                <Text style={[styles.seeAllText, { color: c.mutedForeground }]}>See all {projects.length}</Text>
                <ChevronRight size={16} color={c.mutedForeground} />
              </Pressable>
            )}
          </View>
          {projects === undefined ? (
            <View style={styles.recent}>
              {[0, 1, 2].map((index) => (
                <Animated.View key={index} style={[styles.skeleton, { backgroundColor: c.muted }, PULSE]} />
              ))}
            </View>
          ) : projects.length === 0 ? (
            <Text style={[styles.empty, { color: c.mutedForeground }]}>
              No projects yet. Describe one above or start from a template.
            </Text>
          ) : (
            <View style={styles.recent}>
              {recent.map((project, index) => (
                <Fragment key={project._id}>
                  {index > 0 && <View style={[styles.divider, { backgroundColor: c.border }]} />}
                  <ProjectCard project={project} plain />
                </Fragment>
              ))}
            </View>
          )}

          <StarterTemplates />
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, paddingTop: 28, gap: 10 },
  title: { fontSize: 30, letterSpacing: -0.6, fontFamily: font.semibold, textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: font.regular, textAlign: "center", marginBottom: 14 },
  sectionRow: { flexDirection: "row", alignItems: "center", marginTop: 28, marginBottom: 4 },
  section: { flex: 1, fontSize: 15, fontFamily: font.semibold },
  seeAll: { flexDirection: "row", alignItems: "center", gap: 2 },
  seeAllText: { fontSize: 13, fontFamily: font.medium },
  dim: { opacity: 0.6 },
  recent: { gap: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 6 },
  skeleton: { height: 44, borderRadius: radius.md, marginVertical: 2 },
  empty: { fontSize: 14, fontFamily: font.regular, paddingVertical: 12 },
});

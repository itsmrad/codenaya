import { useMutation, useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Fragment, useEffect } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FirstRunChecklist } from "@/components/first-run-checklist";
import { LabelStrip, monoLabel } from "@/components/grid";
import { ArrowRight, Settings } from "@/components/icons";
import { ProjectCard } from "@/components/project-card";
import { PromptComposer } from "@/components/prompt-composer";
import { StarterTemplates } from "@/components/starter-templates";
import { api } from "@/lib/api";
import { PULSE, fadeUp } from "@/lib/motion";
import { font, useColors } from "@/lib/theme";

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
          <View style={styles.eyebrow}>
            <View style={[styles.bar, { backgroundColor: c.brand }]} />
            <Text style={[monoLabel, { color: c.mutedForeground }]}>[ New project ]</Text>
          </View>
          <Text style={[styles.title, { color: c.foreground }]}>
            What will you <Text style={{ color: c.brandText }}>build?</Text>
          </Text>
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
            Describe an app and Codenaya writes it for you.
          </Text>
        </Animated.View>
        <Animated.View entering={fadeUp({ rise: 12, duration: 500, delay: 100 })}>
          <PromptComposer />
        </Animated.View>
        <Animated.View entering={fadeUp({ rise: 0, duration: 500, delay: 200 })}>
          {projects && <FirstRunChecklist projects={projects} />}

          <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
          <LabelStrip
            label="Your projects"
            right={
              projects &&
              projects.length > 0 && (
                <Pressable
                  onPress={() => router.push("/projects")}
                  hitSlop={8}
                  accessibilityLabel="See all projects"
                  style={({ pressed }) => [styles.seeAll, pressed && styles.dim]}
                >
                  <Text style={[monoLabel, { color: c.foreground }]}>See all {projects.length}</Text>
                  <ArrowRight size={13} color={c.foreground} />
                </Pressable>
              )
            }
          />
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
                  <ProjectCard project={project} />
                </Fragment>
              ))}
            </View>
          )}
          </View>

          <StarterTemplates />
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, paddingTop: 24, gap: 10 },
  eyebrow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  bar: { width: 2, height: 12 },
  title: { fontSize: 30, letterSpacing: -0.8, lineHeight: 34, fontFamily: font.semibold },
  subtitle: { fontSize: 14, fontFamily: font.regular, marginTop: 6, marginBottom: 18 },
  // Full-bleed bordered sections on the grid, like the web dashboard's cells.
  section: { marginHorizontal: -16, marginTop: 28, borderTopWidth: 1, borderBottomWidth: 1 },
  seeAll: { flexDirection: "row", alignItems: "center", gap: 6 },
  dim: { opacity: 0.6 },
  recent: {},
  divider: { height: 1 },
  skeleton: { height: 44, borderRadius: 4, marginHorizontal: 14, marginVertical: 8 },
  empty: { fontSize: 14, fontFamily: font.regular, padding: 16 },
});

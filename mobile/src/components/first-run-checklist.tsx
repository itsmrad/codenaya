import { useUser } from "@clerk/expo";
import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { Doc } from "../../../convex/_generated/dataModel";
import { CheckCircle2, ChevronRight, Circle, X } from "@/components/icons";
import { api } from "@/lib/api";
import { webUrl } from "@/lib/http";
import { getFirstRunProgress } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

// Per user, like the web's localStorage flags (first-run.ts), kept on the device.
const dismissedKey = (userId: string) => `codenaya.first-run-dismissed.${userId}`;
const PREVIEW_OPENED_KEY = "codenaya.preview-opened";

/**
 * The web's "Getting started" checklist, from the user's real data. Steps the
 * app can't do yet open the website. Hidden once done or dismissed.
 */
export function FirstRunChecklist({ projects }: { projects: Doc<"projects">[] }) {
  const c = useColors();
  const { user } = useUser();
  const [dismissed, setDismissed] = useState<boolean>();
  const [previewOpened, setPreviewOpened] = useState(false);

  useEffect(() => {
    if (!user) return;
    SecureStore.getItemAsync(dismissedKey(user.id)).then((value) => setDismissed(value === "1"), () => setDismissed(false));
    SecureStore.getItemAsync(PREVIEW_OPENED_KEY).then((value) => setPreviewOpened(value === "1"), () => undefined);
  }, [user]);

  const active = dismissed === false;
  const aiKeys = useQuery(api.aiProviders.list, active ? {} : "skip");
  const skills = useQuery(api.skills.listLibrary, active ? {} : "skip");
  const published = useQuery(api.showcase.getMyPublished, active ? {} : "skip");
  if (!active || !user || !aiKeys || !skills || !published) return null;

  const progress = getFirstRunProgress({
    projects,
    published,
    aiKeyCount: aiKeys.length,
    skillCount: skills.length,
    githubConnected: user.externalAccounts.some((account) => account.provider === "github"),
    previewOpened,
  });
  const doneCount = Object.values(progress).filter(Boolean).length;
  if (doneCount === Object.keys(progress).length) return null;

  const latest = projects[0] && `/projects/${projects[0]._id}`;
  const steps: { id: keyof typeof progress; label: string; path?: string }[] = [
    { id: "createProject", label: "Create your first app" },
    { id: "openPreview", label: "Open the preview", path: latest && `${latest}?view=preview` },
    { id: "connectGithub", label: "Connect GitHub", path: "/settings/account" },
    { id: "addKeyOrSkill", label: "Add an AI key or a skill", path: "/settings/ai-providers" },
    { id: "ship", label: "Publish or export to GitHub", path: latest },
  ];

  const open = (step: (typeof steps)[number]) => {
    if (!step.path) return;
    if (step.id === "openPreview") {
      // The preview lives on the website for now; count opening it from here.
      SecureStore.setItemAsync(PREVIEW_OPENED_KEY, "1").catch(() => undefined);
      setPreviewOpened(true);
    }
    WebBrowser.openBrowserAsync(webUrl(step.path));
  };

  const dismiss = () => {
    SecureStore.setItemAsync(dismissedKey(user.id), "1").catch(() => undefined);
    setDismissed(true);
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.foreground }]}>Getting started</Text>
          <Text style={[styles.count, { color: c.mutedForeground }]}>
            {doneCount} of {steps.length} done
          </Text>
        </View>
        <Pressable onPress={dismiss} hitSlop={10} accessibilityLabel="Dismiss getting started checklist">
          <X size={16} color={c.mutedForeground} />
        </Pressable>
      </View>
      <View style={[styles.track, { backgroundColor: c.muted }]}>
        <View style={[styles.fill, { backgroundColor: c.brand, width: `${(doneCount / steps.length) * 100}%` }]} />
      </View>
      {steps.map((step) => {
        const done = progress[step.id];
        const actionable = !done && Boolean(step.path);
        return (
          <Pressable key={step.id} onPress={() => open(step)} disabled={!actionable} style={styles.step}>
            {done ? <CheckCircle2 size={16} color={c.brand} /> : <Circle size={16} color={c.mutedForeground} />}
            <Text
              style={[
                styles.label,
                { color: done ? c.mutedForeground : c.foreground },
                done && styles.done,
              ]}
            >
              {step.label}
            </Text>
            {actionable && <ChevronRight size={14} color={c.mutedForeground} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 8, marginTop: 22 },
  header: { flexDirection: "row", alignItems: "flex-start" },
  title: { fontSize: 15, fontFamily: font.semibold },
  count: { fontSize: 12, fontFamily: font.regular, marginTop: 2 },
  track: { height: 4, borderRadius: 2, overflow: "hidden", marginBottom: 4 },
  fill: { height: 4, borderRadius: 2 },
  step: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  label: { flex: 1, fontSize: 14, fontFamily: font.regular },
  done: { textDecorationLine: "line-through" },
});

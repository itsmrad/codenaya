import { useUser } from "@clerk/expo";
import { useQuery } from "convex/react";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { Doc } from "../../../convex/_generated/dataModel";
import { LabelStrip, monoLabel } from "@/components/grid";
import { Check, ChevronRight, X } from "@/components/icons";
import { api } from "@/lib/api";
import { webUrl } from "@/lib/http";
import { getFirstRunProgress } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

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
      <LabelStrip
        label="Getting started"
        right={
          <>
            <Text style={[monoLabel, { color: c.mutedForeground }]}>
              {doneCount} / {steps.length}
            </Text>
            <Pressable
              onPress={dismiss}
              hitSlop={10}
              accessibilityLabel="Dismiss getting started checklist"
              style={[styles.dismiss, { borderColor: c.border }]}
            >
              <X size={14} color={c.mutedForeground} />
            </Pressable>
          </>
        }
      />
      <View style={[styles.track, { backgroundColor: c.muted }]}>
        <View style={[styles.fill, { backgroundColor: c.brand, width: `${(doneCount / steps.length) * 100}%` }]} />
      </View>
      {steps.map((step) => {
        const done = progress[step.id];
        const actionable = !done && Boolean(step.path);
        return (
          <Pressable
            key={step.id}
            onPress={() => open(step)}
            disabled={!actionable}
            style={({ pressed }) => [styles.step, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
          >
            <View style={[styles.mark, done ? { backgroundColor: c.brand } : { borderWidth: 1, borderColor: c.mutedForeground }]}>
              {done && <Check size={11} strokeWidth={3} color={c.brandForeground} />}
            </View>
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
  // A full-bleed bordered section, like the web dashboard's cells.
  card: { borderTopWidth: 1, borderBottomWidth: 1, marginHorizontal: -16, marginTop: 28 },
  dismiss: { marginLeft: 12, paddingLeft: 12, borderLeftWidth: 1, height: 36, justifyContent: "center" },
  track: { height: 2 },
  fill: { height: 2 },
  step: { flexDirection: "row", alignItems: "center", gap: 12, height: 46, paddingHorizontal: 16, borderTopWidth: 1 },
  mark: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, fontSize: 14, fontFamily: font.regular },
  done: { textDecorationLine: "line-through" },
});

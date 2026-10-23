import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { useCreateProject } from "@/lib/create-project";
import { STARTER_TEMPLATES } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

/** Cards shown before "Show more": two rows of two. */
const PREVIEW_COUNT = 4;

/**
 * The web's starter templates (STARTER_TEMPLATES) as a two-column grid of
 * cards: a project seeded with the agent's Vite starter, then built from the
 * template's curated prompt.
 */
export function StarterTemplates() {
  const c = useColors();
  const createProject = useCreateProject();
  const [creating, setCreating] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? STARTER_TEMPLATES : STARTER_TEMPLATES.slice(0, PREVIEW_COUNT);
  const hidden = STARTER_TEMPLATES.length - PREVIEW_COUNT;

  const use = (template: (typeof STARTER_TEMPLATES)[number]) =>
    Alert.alert(`Start a ${template.title.toLowerCase()}?`, template.description, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Create",
        onPress: async () => {
          setCreating(template.id);
          const failed = await createProject(template.prompt, template.id);
          setCreating(undefined);
          if (failed) Alert.alert(failed);
        },
      },
    ]);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: c.foreground }]}>Start from a template</Text>
      <View style={styles.grid}>
        {shown.map((template, index) => (
          <Animated.View
            key={template.id}
            // Cards revealed by "Show more" fade in; the first four are already there.
            entering={index >= PREVIEW_COUNT ? FadeIn.duration(250) : undefined}
            style={styles.cell}
          >
            <Pressable
              onPress={() => use(template)}
              disabled={creating !== undefined}
              accessibilityLabel={`Use the ${template.title} template`}
              style={({ pressed }) => [
                styles.card,
                { backgroundColor: pressed ? c.muted : c.card, borderColor: c.border },
              ]}
            >
              <View style={styles.header}>
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={2}>
                  {template.title}
                </Text>
                {creating === template.id && <ActivityIndicator size="small" color={c.mutedForeground} />}
              </View>
              <Text style={[styles.description, { color: c.mutedForeground }]} numberOfLines={3}>
                {template.description}
              </Text>
              <Text style={[styles.stack, { color: c.mutedForeground }]} numberOfLines={1}>
                {template.techStack.join(" · ")}
              </Text>
            </Pressable>
          </Animated.View>
        ))}
      </View>
      {hidden > 0 && (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.more, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
        >
          <Text style={[styles.moreText, { color: c.foreground }]}>
            {expanded ? "Show less" : `Show ${hidden} more`}
          </Text>
          {expanded ? (
            <ChevronUp size={15} color={c.mutedForeground} />
          ) : (
            <ChevronDown size={15} color={c.mutedForeground} />
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 28 },
  title: { fontSize: 15, fontFamily: font.semibold },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  // Two per row with a small gutter.
  cell: { width: "48.5%" },
  card: { flex: 1, minHeight: 132, borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  name: { flex: 1, fontSize: 14, fontFamily: font.medium },
  description: { flex: 1, fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  stack: { fontSize: 11, fontFamily: font.regular, opacity: 0.8 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 10,
  },
  moreText: { fontSize: 13, fontFamily: font.medium },
});

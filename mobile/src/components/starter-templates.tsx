import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useCreateProject } from "@/lib/create-project";
import { STARTER_TEMPLATES } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

/**
 * The web's starter templates (STARTER_TEMPLATES): a project seeded with the
 * agent's Vite starter, then built from the template's curated prompt.
 */
export function StarterTemplates() {
  const c = useColors();
  const createProject = useCreateProject();
  const [creating, setCreating] = useState<string>();

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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row} contentContainerStyle={styles.cards}>
        {STARTER_TEMPLATES.map((template) => (
          <Pressable
            key={template.id}
            onPress={() => use(template)}
            disabled={creating !== undefined}
            accessibilityLabel={`Use the ${template.title} template`}
            style={({ pressed }) => [
              styles.card,
              { backgroundColor: pressed ? c.muted : c.card, borderColor: c.border },
            ]}
          >
            <View style={styles.header}>
              <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                {template.title}
              </Text>
              {creating === template.id && <ActivityIndicator size="small" color={c.mutedForeground} />}
            </View>
            <Text style={[styles.description, { color: c.mutedForeground }]} numberOfLines={2}>
              {template.description}
            </Text>
            <Text style={[styles.stack, { color: c.mutedForeground }]} numberOfLines={1}>
              {template.techStack.join(" · ")}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 22 },
  title: { fontSize: 15, fontFamily: font.semibold },
  // Bleeds to the screen edges (the list has 16px padding) so cards scroll off cleanly.
  row: { marginHorizontal: -16 },
  cards: { gap: 10, paddingHorizontal: 16 },
  card: { width: 220, borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { flex: 1, fontSize: 14, fontFamily: font.medium },
  description: { fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  stack: { fontSize: 11, fontFamily: font.regular, opacity: 0.8 },
});

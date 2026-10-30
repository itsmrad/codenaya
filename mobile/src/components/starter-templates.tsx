import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { confirm, toast } from "@/components/dialogs";
import { LabelStrip, monoLabel } from "@/components/grid";
import { ProjectCover } from "@/components/project-cover";
import { useCreateProject } from "@/lib/create-project";
import { STARTER_TEMPLATES } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/**
 * The web's starter templates (STARTER_TEMPLATES) as full-width cards with the
 * web's generated preview: a project seeded with the agent's Vite starter,
 * then built from the template's curated prompt.
 */
export function StarterTemplates() {
  const c = useColors();
  const createProject = useCreateProject();
  const [creating, setCreating] = useState<string>();

  const use = async (template: (typeof STARTER_TEMPLATES)[number]) => {
    const confirmed = await confirm({
      title: `Start a ${template.title.toLowerCase()}?`,
      message: template.description,
      confirmLabel: "Create",
    });
    if (!confirmed) return;
    setCreating(template.id);
    const failed = await createProject(template.prompt, template.id);
    setCreating(undefined);
    if (failed) toast.error(failed);
  };

  return (
    <View style={[styles.wrap, { borderColor: c.border }]}>
      <LabelStrip
        label="Start from a template"
        right={<Text style={[monoLabel, { color: c.mutedForeground }]}>{STARTER_TEMPLATES.length}</Text>}
      />
      <View style={styles.grid}>
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
            <View style={[styles.preview, { borderColor: c.border }]}>
              <ProjectCover seed={template.id} style={StyleSheet.absoluteFill} />
              {creating === template.id && (
                <View style={[styles.creating, { backgroundColor: `${c.background}B3` }]}>
                  <ActivityIndicator size="small" color={c.foreground} />
                  <Text style={[styles.creatingText, { color: c.foreground }]}>Creating project…</Text>
                </View>
              )}
            </View>
            <View style={styles.body}>
              <Text style={[styles.name, { color: c.foreground }]}>{template.title}</Text>
              <Text style={[styles.description, { color: c.mutedForeground }]} numberOfLines={2}>
                {template.description}
              </Text>
              <View style={styles.tags}>
                {template.techStack.map((tag) => (
                  <Text key={tag} style={[monoLabel, styles.tag, { color: c.mutedForeground, borderColor: c.border }]}>
                    {tag}
                  </Text>
                ))}
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A full-bleed section strip over the cards, like the web dashboard.
  wrap: { marginHorizontal: -16, marginTop: 28, borderTopWidth: 1 },
  grid: { gap: 14, padding: 16 },
  card: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  preview: { aspectRatio: 16 / 9, borderBottomWidth: 1 },
  creating: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  creatingText: { fontSize: 12, fontFamily: font.medium },
  body: { padding: 14, gap: 6 },
  name: { fontSize: 15, fontFamily: font.semibold },
  description: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
});

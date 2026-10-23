import { ArrowUp, ChartColumn, ListTodo, Rocket, SquareKanban, UserRound } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useCreateProject } from "@/lib/create-project";
import { font, radius, useColors } from "@/lib/theme";

// The web's STARTER_PROMPTS (prompt-composer.tsx): a chip fills the box, it never sends.
const STARTER_PROMPTS = [
  {
    label: "SaaS landing page",
    icon: Rocket,
    prompt: "SaaS landing page with a hero, feature highlights, a pricing table and an FAQ",
  },
  {
    label: "Todo app with auth",
    icon: ListTodo,
    prompt: "Todo app with auth: sign up and log in, and each user sees only their own tasks",
  },
  {
    label: "Portfolio",
    icon: UserRound,
    prompt: "Portfolio site with an about section, a projects grid and a contact form",
  },
  {
    label: "Dashboard with charts",
    icon: ChartColumn,
    prompt: "Dashboard with charts: KPI cards, a revenue line chart and a sortable orders table",
  },
  {
    label: "Kanban board",
    icon: SquareKanban,
    prompt: "Kanban board with drag-and-drop cards across To do, In progress and Done columns",
  },
];

/**
 * The dashboard's "What will you build?" box: creates a project from the
 * prompt through the web's route, then opens it while the agent starts.
 */
export function PromptComposer() {
  const c = useColors();
  const createProject = useCreateProject();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    setBusy(true);
    setError(undefined);
    const failed = await createProject(prompt.trim());
    if (failed) setError(failed);
    else setPrompt("");
    setBusy(false);
  };

  const canSend = prompt.trim().length > 0 && !busy;

  return (
    <View>
      <View style={[styles.box, { backgroundColor: c.card, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.foreground }]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Ask Codenaya to build a SaaS landing page…"
          placeholderTextColor={c.mutedForeground}
          multiline
          editable={!busy}
        />
        <View style={styles.footer}>
          <Pressable
            onPress={create}
            disabled={!canSend}
            accessibilityLabel="Create project"
            style={[styles.send, { backgroundColor: canSend ? c.primary : c.muted }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : (
              <ArrowUp size={16} color={canSend ? c.primaryForeground : c.mutedForeground} />
            )}
          </Pressable>
        </View>
      </View>
      {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
      {/* One left-aligned row that scrolls sideways, rather than wrapped and centred. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chips}
      >
        {STARTER_PROMPTS.map(({ label, icon: Icon, prompt: starter }) => (
          <Pressable
            key={label}
            onPress={() => setPrompt(starter)}
            style={[styles.chip, { borderColor: c.border, backgroundColor: c.card }]}
          >
            <Icon size={14} color={c.mutedForeground} />
            <Text style={[styles.chipText, { color: c.mutedForeground }]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: radius.xl },
  input: {
    minHeight: 80,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
    fontSize: 15,
    lineHeight: 24,
    fontFamily: font.regular,
    textAlignVertical: "top",
  },
  footer: { height: 48, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
  send: { width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  error: { marginTop: 8, fontSize: 13, fontFamily: font.regular },
  // Bleeds to the screen edges (the list has 16px padding) so chips scroll off-screen cleanly.
  chipRow: { marginTop: 16, marginHorizontal: -16 },
  chips: { gap: 8, paddingHorizontal: 16 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 12, fontFamily: font.regular },
});

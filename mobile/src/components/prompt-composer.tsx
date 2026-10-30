import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";

import { ModelSheet, useEnhancePrompt } from "@/components/chat-composer";
import { Corners, LabelStrip, Orbit, monoLabel } from "@/components/grid";
import { ArrowUp, ChevronDown, Paperclip, Undo2, WandSparkles, X } from "@/components/icons";
import { useAgentModel } from "@/lib/agent-model";
import { useCreateProject } from "@/lib/create-project";
import { MAX_CHAT_IMAGES } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

// The web's STARTER_PROMPTS (prompt-composer.tsx): a chip fills the box, it never sends.
const STARTER_PROMPTS = [
  { label: "Landing page", prompt: "SaaS landing page with a hero, feature highlights, a pricing table and an FAQ" },
  { label: "Todo app", prompt: "Todo app with auth: sign up and log in, and each user sees only their own tasks" },
  { label: "Portfolio", prompt: "Portfolio site with an about section, a projects grid and a contact form" },
  { label: "Dashboard", prompt: "Dashboard with charts: KPI cards, a revenue line chart and a sortable orders table" },
  { label: "Kanban board", prompt: "Kanban board with drag-and-drop cards across To do, In progress and Done columns" },
];

// The web's typed placeholder ideas (prompt-composer.tsx).
const PLACEHOLDER_PREFIX = "Ask Codenaya to build ";
const PLACEHOLDER_IDEAS = [
  "a SaaS landing page…",
  "a habit tracker with streaks…",
  "a recipe finder…",
  "a portfolio for a photographer…",
  "an invoice generator…",
];

/**
 * Types each idea into the placeholder, pauses, then moves to the next, like
 * the web. Only while the box is empty and unfocused.
 */
const useTypedPlaceholder = (enabled: boolean) => {
  const [text, setText] = useState(PLACEHOLDER_PREFIX + PLACEHOLDER_IDEAS[0]);
  useEffect(() => {
    if (!enabled) return;
    let idea = 0;
    let length = 0;
    let pause = 0;
    const id = setInterval(() => {
      const target = PLACEHOLDER_IDEAS[idea];
      if (length < target.length) {
        length += 1;
      } else if (pause < 25) {
        pause += 1;
      } else {
        idea = (idea + 1) % PLACEHOLDER_IDEAS.length;
        length = 0;
        pause = 0;
      }
      setText(PLACEHOLDER_PREFIX + PLACEHOLDER_IDEAS[idea].slice(0, length));
    }, 60);
    return () => clearInterval(id);
  }, [enabled]);
  return text;
};

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
  const [focused, setFocused] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const agent = useAgentModel();
  const { enhance, enhancing, canUndo, undo, reset } = useEnhancePrompt(prompt, setPrompt, setError);
  const modelName = agent.label.split(" · ").pop() ?? agent.label;
  const reduceMotion = useReducedMotion();
  const placeholder = useTypedPlaceholder(!reduceMotion && !prompt && !focused);

  const pickImages = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: MAX_CHAT_IMAGES - images.length,
      // Below 1, the picker re-encodes as JPEG: smaller uploads and no HEIC.
      quality: 0.8,
    });
    if (!result.canceled) setImages((current) => [...current, ...result.assets].slice(0, MAX_CHAT_IMAGES));
  };

  const create = async () => {
    if (images.length > 0 && !agent.acceptsImages) {
      setError("This model can't read images. Pick a vision model to send them.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const failed = await createProject(prompt.trim(), undefined, images);
    if (failed) {
      setError(failed);
    } else {
      setPrompt("");
      setImages([]);
      reset();
    }
    setBusy(false);
  };

  const canSend = prompt.trim().length > 0 && !busy;

  return (
    <View>
      {/* The web's composer window: `+` corners, a `[ PROMPT ]` strip, and a
          light circling the border while focused. */}
      <View style={styles.window}>
      <Corners />
      <Orbit active={focused}>
      <Animated.View
        style={[
          styles.box,
          // The orbit's ring stands in for the border while focused.
          { backgroundColor: c.card, borderColor: focused ? "transparent" : c.border },
          { transitionProperty: "borderColor", transitionDuration: 200 },
        ]}
      >
        <LabelStrip
          label="Prompt"
          right={
            <View style={styles.hint}>
              <View style={[styles.dot, { backgroundColor: c.brand }]} />
              <Text style={[monoLabel, { color: c.mutedForeground }]}>
                {prompt ? `${prompt.length} chars` : "New project"}
              </Text>
            </View>
          }
        />
        {images.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {images.map((image) => (
              <View key={image.uri}>
                <Image source={image.uri} style={[styles.thumb, { borderColor: c.border }]} contentFit="cover" />
                <Pressable
                  onPress={() => setImages((current) => current.filter((item) => item.uri !== image.uri))}
                  hitSlop={8}
                  accessibilityLabel="Remove image"
                  style={[styles.remove, { backgroundColor: c.primary }]}
                >
                  <X size={10} color={c.primaryForeground} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <TextInput
          style={[styles.input, { color: c.foreground }]}
          value={prompt}
          onChangeText={setPrompt}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={c.mutedForeground}
          multiline
          editable={!busy}
        />
        {/* A toolbar of cells, like the web's: Enhance, images, the model, then Build. */}
        <View style={[styles.footer, { borderColor: c.border }]}>
          <Pressable
            onPress={canUndo ? undo : enhance}
            disabled={busy || enhancing || (!canUndo && !prompt.trim())}
            accessibilityLabel={canUndo ? "Undo enhance" : "Enhance prompt"}
            style={({ pressed }) => [
              styles.cell,
              { borderColor: c.border },
              pressed && { backgroundColor: c.muted },
              !canUndo && !prompt.trim() && styles.disabled,
            ]}
          >
            {enhancing ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : canUndo ? (
              <Undo2 size={15} color={c.mutedForeground} />
            ) : (
              <WandSparkles size={15} color={c.mutedForeground} />
            )}
          </Pressable>
          <Pressable
            onPress={pickImages}
            disabled={busy || images.length >= MAX_CHAT_IMAGES}
            accessibilityLabel="Attach images"
            style={({ pressed }) => [
              styles.cell,
              { borderColor: c.border },
              pressed && { backgroundColor: c.muted },
              images.length >= MAX_CHAT_IMAGES && styles.disabled,
            ]}
          >
            <Paperclip size={15} color={c.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={() => setModelsOpen(true)}
            disabled={busy}
            accessibilityLabel="Agent model"
            style={({ pressed }) => [styles.cell, styles.model, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
          >
            <Text style={[styles.modelText, { color: c.foreground }]} numberOfLines={1}>
              {modelName}
            </Text>
            <ChevronDown size={13} color={c.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={create}
            disabled={!canSend}
            accessibilityLabel="Create project"
            style={[styles.send, { backgroundColor: canSend ? c.brand : c.muted, borderColor: c.border }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : (
              <ArrowUp size={14} color={canSend ? c.brandForeground : c.mutedForeground} />
            )}
            <Text style={[monoLabel, styles.sendText, { color: canSend ? c.brandForeground : c.mutedForeground }]}>
              {busy ? "Building" : "Build"}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
      </Orbit>
      </View>
      <ModelSheet agent={agent} visible={modelsOpen} onClose={() => setModelsOpen(false)} />
      {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
      {/* One left-aligned row that scrolls sideways, rather than wrapped and centred. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chips}
      >
        {STARTER_PROMPTS.map(({ label, prompt: starter }) => (
          <Pressable
            key={label}
            onPress={() => setPrompt(starter)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: c.border, backgroundColor: pressed ? c.muted : c.card },
            ]}
          >
            <Text style={[styles.chipText, { color: c.foreground }]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  window: { position: "relative" },
  box: { borderWidth: 1, borderRadius: 6 },
  hint: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  input: {
    minHeight: 84,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    fontSize: 15,
    lineHeight: 24,
    fontFamily: font.regular,
    textAlignVertical: "top",
  },
  footer: { height: 44, borderTopWidth: 1, flexDirection: "row", alignItems: "stretch" },
  cell: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 13, borderRightWidth: 1 },
  model: { flexShrink: 1, minWidth: 0, maxWidth: 150, paddingHorizontal: 11 },
  modelText: { flexShrink: 1, fontSize: 12, fontFamily: font.medium },
  thumbs: { gap: 8, paddingHorizontal: 14, paddingTop: 12 },
  thumb: { width: 52, height: 52, borderRadius: 4, borderWidth: 1 },
  remove: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.45 },
  send: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    borderLeftWidth: 1,
    borderBottomRightRadius: 5,
  },
  sendText: { fontFamily: font.monoMedium },
  error: { marginTop: 8, fontSize: 13, fontFamily: font.regular },
  // Bleeds to the screen edges (the list has 16px padding) so chips scroll off-screen cleanly.
  chipRow: { marginTop: 16, marginHorizontal: -16 },
  chips: { gap: 8, paddingHorizontal: 16 },
  chip: { justifyContent: "center", height: 34, paddingHorizontal: 13, borderRadius: 6, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: font.regular, opacity: 0.8 },
});

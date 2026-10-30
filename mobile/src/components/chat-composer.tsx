import { useAuth } from "@clerk/expo";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import Animated from "react-native-reanimated";

import { Corners, LabelStrip, Orbit, monoLabel } from "@/components/grid";
import { ArrowUp, Check, ChevronDown, ListChecks, Paperclip, Slash, Square, Undo2, WandSparkles, X } from "@/components/icons";
import { Sheet, SheetRow, SheetSection } from "@/components/sheet";
import type { useAgentModel } from "@/lib/agent-model";
import { postApi } from "@/lib/http";
import { MAX_CHAT_IMAGES } from "@/lib/shared";
import { type Colors, font, useColors } from "@/lib/theme";

type AgentModel = ReturnType<typeof useAgentModel>;

/** A toolbar cell: an icon, plus a label for the model, highlighted when `active`. */
function ToolButton({
  icon,
  label,
  active,
  disabled,
  onPress,
  c,
  accessibilityLabel,
  shrink,
}: {
  icon: ReactNode;
  label?: string;
  /** Gives up width first, truncating its label (the model name). */
  shrink?: boolean;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  c: Colors;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => [
        styles.cell,
        { borderColor: c.border },
        shrink && styles.shrink,
        (active || pressed) && { backgroundColor: c.muted },
        disabled && styles.disabled,
      ]}
    >
      {label && (
        <Text style={[styles.toolText, shrink && styles.shrink, { color: c.foreground }]} numberOfLines={1}>
          {label}
        </Text>
      )}
      {icon}
    </Pressable>
  );
}

/**
 * Enhance prompt with undo, as on the web: undo stays available until the
 * enhanced text is edited. Shared by the chat and the dashboard's box.
 */
export function useEnhancePrompt(text: string, setText: (text: string) => void, setError: (error?: string) => void) {
  const { getToken } = useAuth();
  const [enhancing, setEnhancing] = useState(false);
  const [enhanced, setEnhanced] = useState<{ original: string; enhanced: string }>();

  const enhance = async () => {
    setEnhancing(true);
    setError(undefined);
    try {
      const { ok, data } = await postApi<{ prompt?: string }>("/api/enhance-prompt", { prompt: text }, getToken);
      if (ok && data.prompt) {
        setEnhanced({ original: text, enhanced: data.prompt });
        setText(data.prompt);
      } else {
        setError(data.error ?? "Unable to enhance prompt");
      }
    } catch {
      setError("Unable to enhance prompt");
    } finally {
      setEnhancing(false);
    }
  };

  return {
    enhance,
    enhancing,
    canUndo: enhanced?.enhanced === text,
    undo: () => {
      if (enhanced) setText(enhanced.original);
      setEnhanced(undefined);
    },
    reset: () => setEnhanced(undefined),
  };
}

/** The agent model picker: the platform's models, then one group per usable key. */
export function ModelSheet({ agent, visible, onClose }: { agent: AgentModel; visible: boolean; onClose: () => void }) {
  const c = useColors();
  return (
    <Sheet visible={visible} title="Agent model" onClose={onClose}>
      {agent.groups.map((group) => (
        <View key={group.keyId ?? "platform"}>
          <SheetSection title={group.title} />
          {group.models.map((model) => {
            const selected = agent.model.modelId === model.id && agent.model.keyId === group.keyId;
            return (
              <SheetRow
                key={model.id}
                label={model.label}
                detail={model.vendor}
                selected={selected}
                trailing={selected ? <Check size={16} color={c.brand} /> : undefined}
                onPress={() => {
                  agent.setModel(group.keyId ? { keyId: group.keyId, modelId: model.id } : { modelId: model.id });
                  onClose();
                }}
              />
            );
          })}
        </View>
      ))}
    </Sheet>
  );
}

/**
 * The chat's message box, like the web composer: text, up to MAX_CHAT_IMAGES
 * images, model picker, Plan toggle, `/` skills and Enhance prompt. While the
 * agent runs, the button stops the run instead of sending.
 */
export function ChatComposer({
  running,
  agent,
  planMode,
  onPlanModeChange,
  skills,
  onSend,
  onStop,
  onFocusChange,
}: {
  running: boolean;
  agent: AgentModel;
  planMode: boolean;
  onPlanModeChange: (planMode: boolean) => void;
  /** The project's enabled skills, for the `/` menu. */
  skills: { name: string; description: string }[];
  /** Resolves to an error message, or undefined once sent. */
  onSend: (text: string, images: ImagePicker.ImagePickerAsset[]) => Promise<string | undefined>;
  onStop: () => Promise<void>;
  onFocusChange?: (focused: boolean) => void;
}) {
  const c = useColors();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sheet, setSheet] = useState<"model" | "skills">();
  const [focused, setFocused] = useState(false);
  const { enhance, enhancing, canUndo, undo, reset } = useEnhancePrompt(text, setText, setError);
  const input = useRef<TextInputInstance>(null);

  // Android's back gesture closes the keyboard but keeps the box focused: blur
  // it, so the glow and the screen's typing state end with the keyboard.
  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidHide", () => input.current?.blur());
    return () => subscription.remove();
  }, []);

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

  const press = async () => {
    if (!running && images.length > 0 && !agent.acceptsImages) {
      setError("This model can't read images. Pick a vision model to send them.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (running) {
        await onStop();
      } else {
        const failed = await onSend(text.trim(), images);
        if (failed) {
          setError(failed);
        } else {
          setText("");
          setImages([]);
          reset();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const insertSkill = (name: string) => {
    // Slash skills lead the message: `/name rest of the prompt`.
    setText((current) => `/${name} ${current.trimStart()}`);
    setSheet(undefined);
  };

  const enabled = !busy && (running || text.trim().length > 0);
  const modelName = agent.label.split(" · ").pop() ?? agent.label;

  return (
    <View style={[styles.wrap, { backgroundColor: c.background, borderColor: c.border }]}>
      {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
      {/* The home composer's window: `+` corners, a `[ MESSAGE ]` strip, and a
          light circling the border while typing. */}
      <View>
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
              label="Message"
              right={
                <View style={styles.hint}>
                  <View style={[styles.dot, { backgroundColor: c.brand }]} />
                  <Text style={[monoLabel, { color: c.mutedForeground }]}>
                    {running ? "Running" : planMode ? "Plan mode" : text ? `${text.length} chars` : "Ready"}
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
              ref={input}
              style={[styles.input, { color: c.foreground }]}
              value={text}
              onChangeText={setText}
              onFocus={() => {
                setFocused(true);
                onFocusChange?.(true);
              }}
              onBlur={() => {
                setFocused(false);
                onFocusChange?.(false);
              }}
              placeholder={
                running ? "Codenaya is working…" : planMode ? "Describe what to plan…" : "Ask Codenaya to change something…"
              }
              placeholderTextColor={c.mutedForeground}
              multiline
            />
            {/* One row of cells, no scrolling: the model name truncates so every tool fits. */}
            <View style={[styles.footer, { borderColor: c.border }]}>
              {canUndo ? (
                <ToolButton
                  c={c}
                  accessibilityLabel="Undo enhance"
                  icon={<Undo2 size={15} color={c.mutedForeground} />}
                  onPress={undo}
                />
              ) : (
                <ToolButton
                  c={c}
                  accessibilityLabel="Enhance prompt"
                  icon={
                    enhancing ? (
                      <ActivityIndicator size="small" color={c.mutedForeground} />
                    ) : (
                      <WandSparkles size={15} color={c.mutedForeground} />
                    )
                  }
                  onPress={enhance}
                  disabled={running || enhancing || !text.trim()}
                />
              )}
              <ToolButton
                c={c}
                accessibilityLabel="Attach images"
                icon={<Paperclip size={15} color={c.mutedForeground} />}
                onPress={pickImages}
                disabled={busy || running || images.length >= MAX_CHAT_IMAGES}
              />
              <ToolButton
                c={c}
                accessibilityLabel="Agent model"
                icon={<ChevronDown size={13} color={c.mutedForeground} />}
                label={modelName}
                shrink
                onPress={() => setSheet("model")}
                disabled={running}
              />
              <ToolButton
                c={c}
                accessibilityLabel="Plan mode"
                icon={<ListChecks size={15} color={planMode ? c.brandText : c.mutedForeground} />}
                active={planMode}
                onPress={() => onPlanModeChange(!planMode)}
                disabled={running}
              />
              {skills.length > 0 && (
                <ToolButton
                  c={c}
                  accessibilityLabel="Skills"
                  icon={<Slash size={14} color={c.mutedForeground} />}
                  onPress={() => setSheet("skills")}
                  disabled={running}
                />
              )}
              <Pressable
                onPress={press}
                disabled={!enabled}
                accessibilityLabel={running ? "Stop" : "Send"}
                style={[
                  styles.send,
                  { borderColor: c.border, backgroundColor: !enabled ? c.muted : running ? c.primary : c.brand },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : running ? (
                  <Square size={12} color={c.primaryForeground} />
                ) : (
                  <ArrowUp size={14} color={enabled ? c.brandForeground : c.mutedForeground} />
                )}
                <Text
                  style={[
                    monoLabel,
                    styles.sendText,
                    { color: !enabled ? c.mutedForeground : running ? c.primaryForeground : c.brandForeground },
                  ]}
                >
                  {running ? "Stop" : "Send"}
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </Orbit>
      </View>

      <ModelSheet agent={agent} visible={sheet === "model"} onClose={() => setSheet(undefined)} />

      <Sheet
        visible={sheet === "skills"}
        title="Skills"
        description="Force a skill for this message. Enable more in the project's Skills on the website."
        onClose={() => setSheet(undefined)}
      >
        {skills.map((skill) => (
          <SheetRow key={skill.name} label={`/${skill.name}`} detail={skill.description} onPress={() => insertSkill(skill.name)} />
        ))}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, gap: 8 },
  box: { borderWidth: 1, borderRadius: 6 },
  hint: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  input: {
    maxHeight: 140,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: font.regular,
    textAlignVertical: "top",
  },
  footer: { height: 44, borderTopWidth: 1, flexDirection: "row", alignItems: "stretch" },
  cell: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 13, borderRightWidth: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  toolText: { fontSize: 12, fontFamily: font.medium },
  disabled: { opacity: 0.45 },
  send: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderLeftWidth: 1,
    borderBottomRightRadius: 5,
  },
  sendText: { fontFamily: font.monoMedium },
  error: { fontSize: 13, fontFamily: font.regular },
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
});

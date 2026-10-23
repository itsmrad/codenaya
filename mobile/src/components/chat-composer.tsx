import { useAuth } from "@clerk/expo";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ImagePlus,
  ListChecks,
  Slash,
  Square,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Sheet, SheetRow, SheetSection } from "@/components/sheet";
import type { useAgentModel } from "@/lib/agent-model";
import { postApi } from "@/lib/http";
import { MAX_CHAT_IMAGES } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

type AgentModel = ReturnType<typeof useAgentModel>;

/** A small toolbar button: icon plus optional label, highlighted when `active`. */
function ToolButton({
  icon,
  label,
  active,
  disabled,
  onPress,
  c,
  accessibilityLabel,
}: {
  icon: ReactNode;
  label?: string;
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
      hitSlop={4}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      style={[styles.tool, active && { backgroundColor: c.muted }, disabled && styles.disabled]}
    >
      {icon}
      {label && (
        <Text style={[styles.toolText, { color: active ? c.foreground : c.mutedForeground }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
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
}) {
  const c = useColors();
  const { getToken } = useAuth();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sheet, setSheet] = useState<"model" | "skills">();
  const [enhancing, setEnhancing] = useState(false);
  // Undo stays available until the enhanced text is edited, as on the web.
  const [enhanced, setEnhanced] = useState<{ original: string; enhanced: string }>();
  const canUndo = enhanced?.enhanced === text;

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
          setEnhanced(undefined);
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
    <View style={[styles.wrap, { backgroundColor: c.background }]}>
      {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
      <View style={[styles.box, { backgroundColor: c.card, borderColor: c.border }]}>
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
          value={text}
          onChangeText={setText}
          placeholder={
            running ? "Codenaya is working…" : planMode ? "Describe what to plan…" : "Ask Codenaya to change something…"
          }
          placeholderTextColor={c.mutedForeground}
          multiline
        />
        <View style={styles.toolbar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.flex} contentContainerStyle={styles.tools}>
            <ToolButton
              c={c}
              accessibilityLabel="Attach images"
              icon={<ImagePlus size={16} color={c.mutedForeground} />}
              onPress={pickImages}
              disabled={busy || running || images.length >= MAX_CHAT_IMAGES}
            />
            <ToolButton
              c={c}
              accessibilityLabel="Agent model"
              icon={<ChevronDown size={14} color={c.mutedForeground} />}
              label={modelName}
              onPress={() => setSheet("model")}
              disabled={running}
            />
            <ToolButton
              c={c}
              accessibilityLabel="Plan mode"
              icon={<ListChecks size={15} color={planMode ? c.brand : c.mutedForeground} />}
              label="Plan"
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
            {canUndo ? (
              <ToolButton
                c={c}
                accessibilityLabel="Undo enhance"
                icon={<Undo2 size={15} color={c.mutedForeground} />}
                label="Undo"
                onPress={() => {
                  setText(enhanced!.original);
                  setEnhanced(undefined);
                }}
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
          </ScrollView>
          <Pressable
            onPress={press}
            disabled={!enabled}
            accessibilityLabel={running ? "Stop" : "Send"}
            style={[styles.button, { backgroundColor: enabled ? c.primary : c.muted }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={c.mutedForeground} />
            ) : running ? (
              <Square size={12} color={c.primaryForeground} fill={c.primaryForeground} />
            ) : (
              <ArrowUp size={16} color={enabled ? c.primaryForeground : c.mutedForeground} />
            )}
          </Pressable>
        </View>
      </View>

      <Sheet visible={sheet === "model"} title="Agent model" onClose={() => setSheet(undefined)}>
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
                    setSheet(undefined);
                  }}
                />
              );
            })}
          </View>
        ))}
      </Sheet>

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
  wrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 6 },
  box: { borderWidth: 1, borderRadius: radius.xl, padding: 8, gap: 4 },
  input: {
    maxHeight: 140,
    minHeight: 40,
    paddingHorizontal: 6,
    paddingVertical: 6,
    fontSize: 15,
    fontFamily: font.regular,
  },
  flex: { flex: 1 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6 },
  tools: { alignItems: "center", gap: 2 },
  tool: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    maxWidth: 170,
  },
  toolText: { fontSize: 12.5, fontFamily: font.medium },
  disabled: { opacity: 0.4 },
  button: { width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 13, fontFamily: font.regular, paddingHorizontal: 4 },
  thumbs: { gap: 8, paddingTop: 4, paddingRight: 4, paddingBottom: 4 },
  thumb: { width: 56, height: 56, borderRadius: radius.md, borderWidth: 1 },
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

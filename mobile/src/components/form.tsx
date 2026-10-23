import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";

import { font, radius, useColors } from "@/lib/theme";

/** A labelled text input, like the web's Field + Input. */
export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.foreground }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={[
          styles.input,
          input.multiline && styles.multiline,
          { color: c.foreground, borderColor: c.border, backgroundColor: c.background },
          input.style,
        ]}
      />
      {hint && <Text style={[styles.hint, { color: c.mutedForeground }]}>{hint}</Text>}
    </View>
  );
}

/** A small set of mutually exclusive choices, like the web's ToggleGroup. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  const c = useColors();
  return (
    <View style={styles.field}>
      {label && <Text style={[styles.label, { color: c.foreground }]}>{label}</Text>}
      <View style={[styles.segments, { borderColor: c.border }]}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityState={{ selected }}
              style={[styles.segment, selected && { backgroundColor: c.muted }]}
            >
              {option.icon}
              <Text style={[styles.segmentText, { color: selected ? c.foreground : c.mutedForeground }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Primary, outline or destructive button; shows a spinner while `busy`. */
export function Button({
  label,
  onPress,
  variant = "primary",
  busy = false,
  disabled = false,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "destructive";
  busy?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const c = useColors();
  const tint = { primary: c.primaryForeground, outline: c.foreground, destructive: c.destructive }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" ? { backgroundColor: c.primary } : { borderWidth: 1, borderColor: c.border },
        (disabled || busy) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : icon}
      <Text style={[styles.buttonText, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 13, fontFamily: font.medium },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: font.regular,
  },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  hint: { fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  segments: { flexDirection: "row", borderWidth: 1, borderRadius: radius.md, padding: 3, gap: 3 },
  segment: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: radius.sm,
    paddingVertical: 8,
  },
  segmentText: { fontSize: 13, fontFamily: font.medium },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  buttonText: { fontSize: 14, fontFamily: font.medium },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});

import { Pressable, StyleSheet, Text, View } from "react-native";

import { LabelStrip, monoLabel } from "@/components/grid";
import { type LucideIcon, Monitor, Moon, Sun } from "@/components/icons";
import { type ThemeChoice, useThemeChoice } from "@/lib/appearance";
import { type Colors, dark, font, light, useColors } from "@/lib/theme";

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** A tiny screen in one palette: a field, an orange button and a card. */
function Preview({ p }: { p: Colors }) {
  return (
    <View style={[styles.preview, { backgroundColor: p.background }]}>
      <View style={[styles.field, { backgroundColor: p.card, borderColor: p.border }]} />
      <View style={[styles.button, { backgroundColor: p.brand }]} />
      <View style={[styles.box, { backgroundColor: p.card, borderColor: p.border }]} />
    </View>
  );
}

/** The web's Appearance settings: Light, Dark or System, kept on this device. */
export default function AppearanceSettings() {
  const c = useColors();
  const [theme, setTheme] = useThemeChoice();
  return (
    <View>
      <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip label="Theme" />
        <View style={styles.cards}>
          {THEMES.map(({ value, label, icon: Icon }) => {
            const selected = theme === value;
            return (
              <Pressable
                key={value}
                onPress={() => setTheme(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                style={({ pressed }) => [
                  styles.card,
                  { backgroundColor: c.card, borderColor: selected ? c.brand : c.border },
                  selected && { boxShadow: `0 6px 20px -6px ${c.brand}66` },
                  pressed && styles.dim,
                ]}
              >
                {value === "system" ? (
                  // Light on the left, dark on the right.
                  <View>
                    <Preview p={light} />
                    <View style={styles.half}>
                      <View style={styles.full}>
                        <Preview p={dark} />
                      </View>
                    </View>
                  </View>
                ) : (
                  <Preview p={value === "dark" ? dark : light} />
                )}
                <View style={[styles.label, { borderColor: c.border }]}>
                  <Icon size={15} color={selected ? c.foreground : c.mutedForeground} />
                  <Text style={[monoLabel, { color: selected ? c.foreground : c.mutedForeground }]}>{label}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Text style={[styles.note, { color: c.mutedForeground }]}>System follows your phone's light or dark setting.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { opacity: 0.8 },
  section: { borderBottomWidth: 1 },
  cards: { flexDirection: "row", gap: 10, padding: 16 },
  card: { flex: 1, borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  preview: { height: 96, padding: 12, gap: 8 },
  field: { height: 12, borderWidth: 1, borderRadius: 3 },
  button: { width: "45%", height: 8, borderRadius: 2 },
  box: { flex: 1, borderWidth: 1, borderRadius: 3 },
  // The right half, showing the right half of a full-width copy.
  half: { position: "absolute", top: 0, bottom: 0, left: "50%", right: 0, overflow: "hidden" },
  full: { position: "absolute", top: 0, bottom: 0, right: 0, width: "200%" },
  label: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 40, borderTopWidth: 1 },
  note: { padding: 16, fontSize: 14, lineHeight: 20, fontFamily: font.regular },
});

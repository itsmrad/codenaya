import { StyleSheet, Text, View } from "react-native";

import { Segmented } from "@/components/form";
import { Monitor, Moon, Sun } from "@/components/icons";
import { useThemeChoice } from "@/lib/appearance";
import { font, radius, useColors } from "@/lib/theme";

/** The web's Appearance settings: System, Light or Dark, kept on this device. */
export default function AppearanceSettings() {
  const c = useColors();
  const [theme, setTheme] = useThemeChoice();
  return (
    <View style={styles.page}>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.foreground }]}>Theme</Text>
        <Text style={[styles.description, { color: c.mutedForeground }]}>
          System follows your device's light or dark setting.
        </Text>
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System", icon: <Monitor size={14} color={c.mutedForeground} /> },
            { value: "light", label: "Light", icon: <Sun size={14} color={c.mutedForeground} /> },
            { value: "dark", label: "Dark", icon: <Moon size={14} color={c.mutedForeground} /> },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 16, gap: 6 },
  title: { fontSize: 15, fontFamily: font.semibold },
  description: { fontSize: 13, fontFamily: font.regular, marginBottom: 8 },
});

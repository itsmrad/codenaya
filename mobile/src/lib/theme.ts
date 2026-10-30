import { DarkTheme, DefaultTheme, type Theme } from "expo-router";
import { useColorScheme } from "react-native";

// The web app's design tokens (src/app/globals.css, :root and .dark).
export const light = {
  background: "#faf8f5",
  foreground: "#1a1a1a",
  card: "#ffffff",
  primary: "#1a1a1a",
  primaryForeground: "#faf8f5",
  muted: "#f0ece6",
  mutedForeground: "#6b6560",
  destructive: "#dc2626",
  border: "rgba(26, 26, 26, 0.08)",
  brand: "#e8824f",
  brandForeground: "#1a1a1a",
  brandText: "#a24415",
  success: "#15803d",
};

export const dark: typeof light = {
  background: "#09090b",
  foreground: "#f0ece6",
  card: "#131316",
  primary: "#f0ece6",
  primaryForeground: "#09090b",
  muted: "#1c1c20",
  mutedForeground: "#8a8580",
  destructive: "#ef4444",
  border: "rgba(255, 255, 255, 0.08)",
  brand: "#e8824f",
  brandForeground: "#09090b",
  brandText: "#e8824f",
  success: "#4ade80",
};
// Which one shows is the Appearance setting (lib/appearance.ts); dark by default.

export type Colors = typeof light;

export const useColors = (): Colors => (useColorScheme() === "dark" ? dark : light);

/** `--radius` is 0.75rem; sm/md/lg/xl as in globals.css. */
export const radius = { sm: 8, md: 10, lg: 12, xl: 16 };

/** Inter and IBM Plex Mono, as on the web. React Native picks a font file per weight. */
export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
};

/** Headers and screen backgrounds in the same tokens. */
export const useNavigationTheme = (): Theme => {
  const scheme = useColorScheme();
  const c = scheme === "dark" ? dark : light;
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.brand,
      background: c.background,
      card: c.background,
      text: c.foreground,
      border: c.border,
    },
    fonts: {
      regular: { fontFamily: font.regular, fontWeight: "400" },
      medium: { fontFamily: font.medium, fontWeight: "500" },
      bold: { fontFamily: font.semibold, fontWeight: "600" },
      heavy: { fontFamily: font.bold, fontWeight: "700" },
    },
  };
};

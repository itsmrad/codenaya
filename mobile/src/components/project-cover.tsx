import { StyleSheet, View, type ViewStyle, useColorScheme } from "react-native";
import Svg, { Defs, Polyline, RadialGradient, Rect, Stop } from "react-native-svg";

import { hashSeed } from "@/lib/project-cover";
import { type Colors, useColors } from "@/lib/theme";

// A port of the web's ProjectCover (src/components/project-cover.tsx and the
// .project-cover styles): a two-hue gradient picked from the seed, with a mini
// browser window showing one of three app-like layouts. The web's oklch
// colours are approximated in hsl.

const palette = (hue: number, hue2: number, dark: boolean) =>
  dark
    ? { base: `hsl(${hue}, 22%, 13%)`, glow: `hsl(${hue}, 45%, 30%)`, glow2: `hsl(${hue2}, 45%, 27%)`, accent: `hsl(${hue}, 65%, 62%)` }
    : { base: `hsl(${hue}, 45%, 94%)`, glow: `hsl(${hue}, 60%, 83%)`, glow2: `hsl(${hue2}, 60%, 80%)`, accent: `hsl(${hue}, 60%, 52%)` };

/** A skeleton bar in the foreground colour at a given strength. */
const Bar = ({ c, alpha = 0.1, style }: { c: Colors; alpha?: number; style?: ViewStyle }) => (
  <View style={[styles.bar, { backgroundColor: c.foreground, opacity: alpha }, style]} />
);

const Landing = ({ c, accent }: { c: Colors; accent: string }) => (
  <View style={styles.landing}>
    <Bar c={c} alpha={0.2} style={{ width: "60%", height: 10 }} />
    <Bar c={c} style={{ width: "40%" }} />
    <View style={[styles.pill, { backgroundColor: accent, width: "20%" }]} />
    <View style={styles.tiles}>
      {[0, 1, 2].map((i) => (
        <Bar key={i} c={c} alpha={0.06} style={styles.tile} />
      ))}
    </View>
  </View>
);

const Dashboard = ({ c, accent }: { c: Colors; accent: string }) => (
  <View style={styles.dashboard}>
    <View style={styles.sidebar}>
      <View style={[styles.bar, { backgroundColor: accent, opacity: 0.7 }]} />
      <Bar c={c} style={{ width: "80%" }} />
      <Bar c={c} style={{ width: "60%" }} />
      <Bar c={c} style={{ width: "80%" }} />
    </View>
    <View style={styles.main}>
      <View style={styles.kpis}>
        {[0, 1, 2].map((i) => (
          <Bar key={i} c={c} alpha={0.07} style={styles.kpi} />
        ))}
      </View>
      <View style={styles.chart}>
        <Bar c={c} alpha={0.05} style={StyleSheet.absoluteFill} />
        <Svg viewBox="0 0 100 40" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
          <Polyline points="0,32 15,26 30,29 45,18 60,21 75,10 100,14" fill="none" stroke={accent} strokeWidth={2} />
        </Svg>
      </View>
    </View>
  </View>
);

const List = ({ c, accent }: { c: Colors; accent: string }) => (
  <View style={styles.list}>
    <View style={styles.listHeader}>
      <Bar c={c} alpha={0.2} style={{ width: "33%", height: 10 }} />
      <View style={[styles.pill, { backgroundColor: accent, width: 32, marginTop: 0 }]} />
    </View>
    {[0.9, 0.7, 0.8, 0.6].map((width, i) => (
      <View key={i} style={styles.listRow}>
        <Bar c={c} alpha={0.05} style={StyleSheet.absoluteFill} />
        <View style={[styles.check, { borderColor: c.foreground }]} />
        <Bar c={c} style={{ width: `${width * 85}%` }} />
      </View>
    ))}
  </View>
);

const LAYOUTS = [Landing, Dashboard, List];

/** A generated cover for a seed, the same as the web draws for it. */
export function ProjectCover({ seed, style }: { seed: string; style?: ViewStyle }) {
  const c = useColors();
  const dark = useColorScheme() !== "light";
  const hash = hashSeed(seed);
  const hue = hash % 360;
  const colors = palette(hue, (hue + 40 + ((hash >>> 16) % 80)) % 360, dark);
  const Layout = LAYOUTS[(hash >>> 9) % LAYOUTS.length];

  return (
    <View style={[styles.cover, style]} pointerEvents="none">
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="glow" cx="15%" cy="10%" r="60%">
            <Stop offset="0" stopColor={colors.glow} />
            <Stop offset="1" stopColor={colors.glow} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="glow2" cx="90%" cy="95%" r="55%">
            <Stop offset="0" stopColor={colors.glow2} />
            <Stop offset="1" stopColor={colors.glow2} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={colors.base} />
        <Rect width="100%" height="100%" fill="url(#glow)" />
        <Rect width="100%" height="100%" fill="url(#glow2)" />
      </Svg>
      <View style={[styles.window, { borderColor: c.border, backgroundColor: `${c.background}D9` }]}>
        <View style={[styles.chrome, { borderColor: c.border }]}>
          {[0, 1, 2].map((i) => (
            <Bar key={i} c={c} alpha={0.15} style={styles.dot} />
          ))}
        </View>
        <Layout c={c} accent={colors.accent} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { overflow: "hidden" },
  window: {
    position: "absolute",
    left: "9%",
    right: "9%",
    top: "14%",
    bottom: -8,
    borderWidth: 1,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    overflow: "hidden",
  },
  chrome: { height: 16, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, borderBottomWidth: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  bar: { height: 6, borderRadius: 3 },
  pill: { height: 12, borderRadius: 6, marginTop: 4 },
  landing: { alignItems: "center", gap: 6, paddingHorizontal: "10%", paddingTop: "6%" },
  tiles: { flexDirection: "row", gap: 6, width: "100%", marginTop: 8 },
  tile: { flex: 1, height: 32, borderRadius: 6 },
  dashboard: { flex: 1, flexDirection: "row", gap: 8, padding: 8 },
  sidebar: { width: "20%", gap: 6, paddingTop: 4 },
  main: { flex: 1, gap: 6 },
  kpis: { flexDirection: "row", gap: 6 },
  kpi: { flex: 1, height: 20, borderRadius: 6 },
  chart: { flex: 1, borderRadius: 6, overflow: "hidden" },
  list: { gap: 6, paddingHorizontal: "8%", paddingTop: "5%" },
  listHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  listRow: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 5, overflow: "hidden" },
  check: { width: 8, height: 8, borderRadius: 2, borderWidth: 1, opacity: 0.2 },
});

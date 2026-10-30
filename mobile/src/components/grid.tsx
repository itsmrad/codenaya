import type { NativeStackHeaderProps } from "expo-router";
import { type ReactNode, useEffect } from "react";
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";

import { ChevronLeft, type LucideIcon } from "@/components/icons";

import { font, useColors } from "@/lib/theme";

// The web's grid language (src/components/landing/section-header.tsx): `+`
// marks where lines cross, `▍[ LABEL ]` strips and mono uppercase labels.

/** Mono uppercase label text, like the web's 10px `[ LABEL ]`s. */
export const monoLabel = {
  fontFamily: font.mono,
  fontSize: 10,
  letterSpacing: 1.4,
  textTransform: "uppercase",
} as const;

/** A `+` where two grid lines cross, positioned by `style`. */
export function GridCross({ style }: { style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View pointerEvents="none" style={[styles.cross, style]}>
      <Svg width={9} height={9} viewBox="0 0 9 9">
        <Path d="M4.5 0v9M0 4.5h9" stroke={c.foreground} strokeOpacity={0.3} strokeWidth={1} />
      </Svg>
    </View>
  );
}

/** `+` marks on the four corners of the parent, which must not clip them. */
export function Corners() {
  return (
    <>
      <GridCross style={{ top: -5, left: -5 }} />
      <GridCross style={{ top: -5, right: -5 }} />
      <GridCross style={{ bottom: -5, left: -5 }} />
      <GridCross style={{ bottom: -5, right: -5 }} />
    </>
  );
}

/**
 * The `▍[ LABEL ]` strip across the top of a window or section; `right` sits
 * at its end, `cell` in a full-height cell split off by a rule.
 */
export function LabelStrip({ label, right, cell }: { label: string; right?: ReactNode; cell?: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.strip, { borderColor: c.border }]}>
      <View style={[styles.bar, { backgroundColor: c.brand }]} />
      <Text style={[monoLabel, { color: c.mutedForeground }]}>[ {label} ]</Text>
      {right != null && <View style={styles.right}>{right}</View>}
      {cell != null && <View style={[styles.cell, { borderColor: c.border }]}>{cell}</View>}
    </View>
  );
}

/**
 * A full-width row under a LabelStrip: an icon in a bordered tile, a label
 * (red when `destructive`), an optional detail and a trailing slot.
 */
export function TileRow({
  icon: Icon,
  label,
  detail,
  trailing,
  onPress,
  destructive,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  trailing?: ReactNode;
  onPress: () => void;
  destructive?: boolean;
}) {
  const c = useColors();
  const tint = destructive ? c.destructive : c.foreground;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tileRow, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
    >
      <View
        style={[
          styles.tile,
          destructive
            ? { borderColor: `${c.destructive}40`, backgroundColor: `${c.destructive}0d` }
            : { borderColor: c.border, backgroundColor: c.background },
        ]}
      >
        <Icon size={18} color={tint} />
      </View>
      <View style={styles.tileText}>
        <Text style={[styles.tileLabel, { color: tint }]}>{label}</Text>
        {detail && (
          <Text style={[styles.tileDetail, { color: c.mutedForeground }]} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {trailing}
    </Pressable>
  );
}

/** The faint dot grid behind windows; fills the parent. */
export function DotGrid() {
  const c = useColors();
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id="dots" width={14} height={14} patternUnits="userSpaceOnUse">
          <Circle cx={1} cy={1} r={0.8} fill={c.foreground} fillOpacity={0.08} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#dots)" />
    </Svg>
  );
}

/** Extra room between the status bar and the header's top rule. */
const STATUS_GAP = 10;

/**
 * Every screen's header as grid cells: back (or the screen's headerLeft), the
 * title, and the screen's headerRight, each split by a rule.
 */
export function GridHeader({ back, options, route, navigation }: NativeStackHeaderProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const title = typeof options.headerTitle === "string" ? options.headerTitle : (options.title ?? route.name);
  const item = { tintColor: c.foreground, canGoBack: back != null };
  return (
    // The status bar sits above its own rule, as in the mockup, with room
    // below it to match the gap above the camera cutout.
    <View style={{ paddingTop: insets.top + STATUS_GAP, backgroundColor: c.background }}>
      <View style={[styles.header, { borderColor: c.border }]}>
        {options.headerLeft ? (
          <View style={[styles.headerCell, { borderColor: c.border }]}>{options.headerLeft(item)}</View>
        ) : (
          back && (
            <Pressable
              onPress={navigation.goBack}
              accessibilityLabel="Back"
              style={({ pressed }) => [styles.backCell, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
            >
              <ChevronLeft size={20} color={c.foreground} />
            </Pressable>
          )
        )}
        <Text style={[styles.headerTitle, { color: c.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {options.headerRight && (
          <View style={[styles.headerRight, { borderColor: c.border }]}>{options.headerRight(item)}</View>
        )}
      </View>
    </View>
  );
}

// The orbit's wedges: drawn on a square much larger than any box, so a turning
// wedge always crosses the box's edge.
const ORBIT = 800;
const R = ORBIT / 2;
/** The radius of each ambient light. */
const LIGHT = 90;
const point = (deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: R + R * Math.cos(rad), y: R + R * Math.sin(rad) };
};
const wedge = (from: number, to: number) => {
  const a = point(from);
  const b = point(to);
  return `M${R} ${R}L${a.x} ${a.y}A${R} ${R} 0 0 1 ${b.x} ${b.y}Z`;
};

/**
 * The web's composer orbit (.composer-orbit): while `active`, a light circles
 * the border and its blurred copy glows around the box. RN has no conic
 * gradient or blur, so gradient wedges turn behind the content (which covers
 * all but a 1.5px ring), and two soft radial lights travel around its edge.
 * The content should be a box with a 6px radius.
 */
export function Orbit({ active, children }: { active: boolean; children: ReactNode }) {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const angle = useSharedValue(0);
  const shown = useSharedValue(0);
  const box = useSharedValue({ width: 0, height: 0 });

  useEffect(() => {
    shown.value = withTiming(active ? 1 : 0, { duration: 400 });
  }, [active, shown]);

  // Turns only while shown, like the web's 4s loop; still for reduced motion.
  useEffect(() => {
    if (!active || reduceMotion) return;
    angle.value = withRepeat(withTiming(angle.value + 360, { duration: 4000, easing: Easing.linear }), -1);
    return () => cancelAnimation(angle);
  }, [active, reduceMotion, angle]);

  const spin = useAnimatedStyle(() => ({ opacity: shown.value * 0.85, transform: [{ rotate: `${angle.value}deg` }] }));
  const halo = useAnimatedStyle(() => ({ opacity: shown.value * 0.35 }));
  // Each light rides the box's edge (an ellipse through its sides) with the ring.
  const along = (offset: number) => {
    "worklet";
    const t = ((angle.value + offset) * Math.PI) / 180;
    return [
      { translateX: (box.value.width / 2) * Math.cos(t) },
      { translateY: (box.value.height / 2) * Math.sin(t) },
    ];
  };
  const lead = useAnimatedStyle(() => ({ opacity: shown.value, transform: along(-15) }));
  const trail = useAnimatedStyle(() => ({ opacity: shown.value * 0.55, transform: along(155) }));
  const edge = point(0);
  const tail = point(-70);
  const light = (id: string) => (
    <Svg width={LIGHT * 2} height={LIGHT * 2}>
      <Defs>
        <RadialGradient id={id} cx={LIGHT} cy={LIGHT} r={LIGHT} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={c.brand} stopOpacity={0.75} />
          <Stop offset="0.45" stopColor={c.brand} stopOpacity={0.3} />
          <Stop offset="1" stopColor={c.brand} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={LIGHT} cy={LIGHT} r={LIGHT} fill={`url(#${id})`} />
    </Svg>
  );

  return (
    <View onLayout={(event) => (box.value = event.nativeEvent.layout)}>
      <Animated.View pointerEvents="none" style={[styles.halo, { boxShadow: `0 8px 40px 4px ${c.brand}` }, halo]} />
      <Animated.View pointerEvents="none" style={[styles.light, lead]}>
        {light("lead")}
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.light, trail]}>
        {light("trail")}
      </Animated.View>
      <View style={styles.ring}>
        <View pointerEvents="none" style={styles.center}>
          <Animated.View style={spin}>
            <Svg width={ORBIT} height={ORBIT}>
              <Defs>
                <LinearGradient id="orbit" gradientUnits="userSpaceOnUse" x1={tail.x} y1={tail.y} x2={edge.x} y2={edge.y}>
                  <Stop offset="0" stopColor={c.brand} stopOpacity={0} />
                  <Stop offset="0.75" stopColor={c.brand} />
                  <Stop offset="1" stopColor="#ffd9c4" />
                </LinearGradient>
              </Defs>
              <Path d={wedge(-70, 0)} fill="url(#orbit)" />
              {/* The fainter second light, opposite, as on the web. */}
              <Path d={wedge(130, 175)} fill={c.brand} fillOpacity={0.45} />
            </Svg>
          </Animated.View>
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  halo: { position: "absolute", top: 6, right: 6, bottom: 6, left: 6, borderRadius: 8 },
  light: { position: "absolute", top: "50%", left: "50%", marginTop: -LIGHT, marginLeft: -LIGHT },
  ring: { borderRadius: 7.5, overflow: "hidden", padding: 1.5 },
  center: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  cross: { position: "absolute", zIndex: 10 },
  header: { flexDirection: "row", alignItems: "stretch", borderTopWidth: 1, borderBottomWidth: 1 },
  headerCell: { height: 48, justifyContent: "center", paddingHorizontal: 16, borderRightWidth: 1 },
  // Unpadded: one icon centres in a square cell; a screen may lay out several cells.
  headerRight: { minWidth: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", borderLeftWidth: 1 },
  backCell: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRightWidth: 1 },
  headerTitle: { flex: 1, alignSelf: "center", paddingHorizontal: 16, fontSize: 17, letterSpacing: -0.2, fontFamily: font.semibold },
  strip: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  bar: { width: 2, height: 12 },
  tileRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  tile: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  tileText: { flex: 1 },
  tileLabel: { fontSize: 15, fontFamily: font.medium },
  tileDetail: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  right: { marginLeft: "auto", flexDirection: "row", alignItems: "center" },
  // Out to the strip's right edge, over its padding.
  cell: {
    alignSelf: "stretch",
    marginLeft: "auto",
    marginRight: -14,
    minWidth: 40,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 1,
  },
});

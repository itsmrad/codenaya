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
import Svg, { Circle, Defs, Path, Pattern, Rect } from "react-native-svg";

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
export function LabelStrip({
  label,
  right,
  cell,
  barColor,
}: {
  label: string;
  right?: ReactNode;
  cell?: ReactNode;
  /** The bar's colour; brand orange unless set (red for deletes). */
  barColor?: string;
}) {
  const c = useColors();
  return (
    <View style={[styles.strip, { borderColor: c.border }]}>
      <View style={[styles.bar, { backgroundColor: barColor ?? c.brand }]} />
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
 * title, and the screen's headerRight; back and headerRight are split off by
 * a rule, the logo is not.
 */
export function GridHeader({ back, options, route, navigation }: NativeStackHeaderProps) {
  const c = useColors();
  const title = typeof options.headerTitle === "string" ? options.headerTitle : (options.title ?? route.name);
  const item = { tintColor: c.foreground, canGoBack: back != null };
  return (
    <HeaderFrame>
      {options.headerLeft ? (
        <View style={styles.headerCell}>{options.headerLeft(item)}</View>
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
    </HeaderFrame>
  );
}

/**
 * A header's frame: the status bar sits above its own rule, as in the mockup,
 * with room below it to match the gap above the camera cutout. A screen with
 * its own cells (the project) fills it directly.
 */
export function HeaderFrame({ children }: { children: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + STATUS_GAP, backgroundColor: c.background }}>
      <View style={[styles.header, { borderColor: c.border }]}>{children}</View>
    </View>
  );
}

// The orbit's conic gradient, as thin wedges on a square much larger than any
// box, so a turning wedge always crosses the box's edge.
const ORBIT = 800;
const R = ORBIT / 2;
const point = (deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: R + R * Math.cos(rad), y: R + R * Math.sin(rad) };
};
const wedge = (from: number, to: number) => {
  const a = point(from);
  const b = point(to);
  return `M${R} ${R}L${a.x} ${a.y}A${R} ${R} 0 0 1 ${b.x} ${b.y}Z`;
};
// The web's stops (globals.css .composer-orbit), as [percent, opacity, white mix].
const STOPS: [number, number, number][] = [
  [0, 0, 0], [10, 1, 0], [16, 1, 0.55], [30, 0, 0], [50, 0, 0], [62, 0.7, 0], [78, 0, 0], [100, 0, 0],
];
const SLICE = 3;
const sample = (percent: number) => {
  const i = STOPS.findIndex(([at]) => at >= percent);
  const [a, oa, wa] = STOPS[Math.max(i - 1, 0)];
  const [b, ob, wb] = STOPS[i];
  const t = b === a ? 0 : (percent - a) / (b - a);
  return { opacity: oa + (ob - oa) * t, white: wa + (wb - wa) * t };
};
/** `from` moved `amount` of the way to `to`; both #rrggbb. */
const mix = (from: string, to: string, amount: number) => {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
};
// Web angles start at the top and turn clockwise; SVG's start at the right.
const SLICES = Array.from({ length: 360 / SLICE }, (_, i) => ({ from: i * SLICE - 90, ...sample(((i + 0.5) * SLICE) / 3.6) }));
// Where the two lights sit (web's 13% and 62%), for the ambient glow.
const LEAD = 0.13 * 360;
const TRAIL = 0.62 * 360;
const GLOW = 8;

/**
 * The web's composer orbit (.composer-orbit): while `active`, a light circles
 * the border and a blurred copy of it glows around the box. RN has no conic
 * gradient or blur, so the gradient turns behind the content (which covers
 * all but a 1.5px ring), and soft shadows follow its two lights.
 * The content should be a box with a 6px radius.
 */
export function Orbit({ active, children }: { active: boolean; children: ReactNode }) {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const angle = useSharedValue(0);
  const shown = useSharedValue(0);

  useEffect(() => {
    shown.value = withTiming(active ? 1 : 0, { duration: 400 });
  }, [active, shown]);

  // Turns only while shown, like the web's 4s loop; still for reduced motion.
  useEffect(() => {
    if (!active || reduceMotion) return;
    angle.value = withRepeat(withTiming(angle.value + 360, { duration: 4000, easing: Easing.linear }), -1);
    return () => cancelAnimation(angle);
  }, [active, reduceMotion, angle]);

  const brand = c.brand;
  const spin = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ rotate: `${angle.value}deg` }] }));
  // The web's blurred copy at 0.55: one soft shadow under each light.
  const glow = useAnimatedStyle(() => {
    const offset = (deg: number) => {
      const t = ((angle.value + deg) * Math.PI) / 180;
      return `${(GLOW * Math.sin(t)).toFixed(1)}px ${(-GLOW * Math.cos(t)).toFixed(1)}px`;
    };
    return {
      opacity: shown.value * 0.55,
      boxShadow: `${offset(LEAD)} 22px 0px ${brand}, ${offset(TRAIL)} 22px -4px ${brand}b3`,
    };
  });

  return (
    <View>
      <Animated.View pointerEvents="none" style={[styles.glow, glow]} />
      <View style={styles.ring}>
        <View pointerEvents="none" style={styles.center}>
          <Animated.View style={spin}>
            <Svg width={ORBIT} height={ORBIT}>
              {/* Opaque slices, blended over the page, so their overlap leaves no seams. */}
              {SLICES.map((slice) => (
                <Path
                  key={slice.from}
                  d={wedge(slice.from, slice.from + SLICE + 0.5)}
                  fill={mix(mix(brand, "#ffffff", slice.white), c.background, 1 - slice.opacity)}
                />
              ))}
            </Svg>
          </Animated.View>
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  glow: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: 7.5 },
  ring: { borderRadius: 7.5, overflow: "hidden", padding: 1.5 },
  center: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  cross: { position: "absolute", zIndex: 10 },
  header: { flexDirection: "row", alignItems: "stretch", borderTopWidth: 1, borderBottomWidth: 1 },
  headerCell: { height: 48, justifyContent: "center", paddingHorizontal: 16 },
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

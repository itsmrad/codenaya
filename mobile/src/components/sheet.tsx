import { type ReactNode, useEffect, useId, useState } from "react";
import {
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { LabelStrip, monoLabel } from "@/components/grid";
import { useSheetPortal } from "@/components/sheet-host";
import { font, radius, useColors } from "@/lib/theme";

// iOS's sheet curve: quick, then settling with no overshoot.
const OPEN = { duration: 300, easing: Easing.bezier(0.32, 0.72, 0, 1) };
const CLOSE = { duration: 200, easing: Easing.in(Easing.cubic) };
const SNAP_BACK = { duration: 220, easing: Easing.out(Easing.cubic) };
/** A drag past this share of the sheet's height, or a flick, closes it. */
const DISMISS_SHARE = 0.3;
const DISMISS_VELOCITY = 900;

type SheetProps = {
  visible: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

/** The backdrop and panel, drawn by the SheetHost above every screen. */
function SheetLayer({
  title,
  description,
  onClose,
  children,
  progress,
  drag,
}: SheetProps & { progress: SharedValue<number>; drag: SharedValue<number> }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // The sheet starts a full screen below its resting place, so it is always
  // off-screen however tall it turns out; measuring it first would jump.
  const { height } = useWindowDimensions();
  const sheetHeight = useSharedValue(400);
  // The backdrop lightens as the sheet is pulled down.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.get() * (1 - Math.min(1, drag.get() / sheetHeight.get())),
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.get()) * height + drag.get() }],
  }));

  // Pull the handle (or title) down: the sheet follows the finger, then closes
  // past a third of its height or on a flick, and springs back otherwise.
  const pan = usePanGesture({
    minDistance: 4,
    onUpdate: (event) => {
      "worklet";
      drag.set(Math.max(0, event.translationY));
    },
    onDeactivate: (event) => {
      "worklet";
      if (event.translationY > sheetHeight.get() * DISMISS_SHARE || event.velocityY > DISMISS_VELOCITY) {
        scheduleOnRN(onClose);
      } else {
        drag.set(withTiming(0, SNAP_BACK));
      }
    },
  });

  return (
    // Sheets with fields rise above the keyboard.
    <KeyboardAvoidingView behavior="padding" style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <View style={styles.flex} pointerEvents="none" />
      <Animated.View
        onLayout={(event) => sheetHeight.set(event.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          // Runs to the bottom edge, behind the navigation bar; only the
          // content keeps clear of it.
          { backgroundColor: c.card, borderColor: c.border, paddingBottom: insets.bottom },
          sheetStyle,
        ]}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.grab} accessibilityHint="Drag down to close">
            <View style={[styles.handle, { backgroundColor: c.border }]} />
            <View style={[styles.title, { borderColor: c.border, backgroundColor: c.background }]}>
              <LabelStrip label={title} />
            </View>
            {description && <Text style={[styles.description, { color: c.mutedForeground }]}>{description}</Text>}
          </View>
        </GestureDetector>
        <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

/**
 * A bottom sheet for pickers and lists (models, conversations, versions). One
 * progress value fades the backdrop and slides the panel, in and out, so both
 * stay in step. Android's back button closes it.
 */
export function Sheet(props: SheetProps) {
  const { visible, onClose } = props;
  const id = useId();
  const place = useSheetPortal();
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  // Stays mounted after `visible` turns false, until the close animation ends.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    if (visible) {
      drag.set(0);
      progress.set(withTiming(1, OPEN));
    } else {
      progress.set(
        withTiming(0, CLOSE, (finished) => {
          if (finished) scheduleOnRN(setMounted, false);
        }),
      );
    }
  }, [visible, progress, drag]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [visible, onClose]);

  // Hand the current content to the host on every render, so it stays live.
  useEffect(() => {
    place(id, mounted ? <SheetLayer {...props} progress={progress} drag={drag} /> : null);
  });
  useEffect(() => () => place(id, null), [id, place]);

  return null;
}

/** One tappable row in a sheet or list: an optional icon, a label (red when `destructive`), a muted detail, and a trailing slot. */
export function SheetRow({
  icon,
  label,
  detail,
  selected,
  trailing,
  onPress,
  disabled,
  destructive,
}: {
  icon?: ReactNode;
  label: string;
  detail?: string;
  selected?: boolean;
  trailing?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** Red label, for deletes. */
  destructive?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        styles.row,
        { borderColor: c.border },
        (pressed || selected) && { backgroundColor: c.muted },
        disabled && styles.disabled,
      ]}
    >
      {icon}
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: destructive ? c.destructive : c.foreground }]} numberOfLines={1}>
          {label}
        </Text>
        {detail && (
          <Text style={[styles.detail, { color: c.mutedForeground }]} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {trailing}
    </Pressable>
  );
}

export function SheetSection({ title }: { title: string }) {
  const c = useColors();
  return <Text style={[monoLabel, styles.section, { color: c.mutedForeground }]}>{title}</Text>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    maxHeight: "75%",
    borderTopLeftRadius: radius.xl + 4,
    borderTopRightRadius: radius.xl + 4,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 8,
  },
  // The draggable top: tall enough to grab easily with a thumb.
  grab: { paddingTop: 4, paddingBottom: 2 },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, marginBottom: 12 },
  title: { borderTopWidth: 1 },
  description: { fontSize: 14, lineHeight: 20, fontFamily: font.regular, paddingHorizontal: 16, marginVertical: 14 },
  // Rows start right under the title strip and end at the last one.
  body: { paddingHorizontal: 8 },
  // Full-bleed grid rows across the body's padding, split by rules.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginHorizontal: -8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  rowText: { flex: 1, minWidth: 0 },
  label: { fontSize: 15, fontFamily: font.regular },
  detail: { fontSize: 12, fontFamily: font.regular, marginTop: 2 },
  section: { paddingHorizontal: 8, paddingTop: 16, paddingBottom: 8 },
  disabled: { opacity: 0.5 },
});

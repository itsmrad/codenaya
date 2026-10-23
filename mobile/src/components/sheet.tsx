import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { font, radius, useColors } from "@/lib/theme";

const SHEET_EASE = Easing.bezier(0.32, 0.72, 0, 1);

/** A bottom sheet for pickers and lists (models, conversations, versions). */
export function Sheet({
  visible,
  title,
  description,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    // The backdrop fades while the sheet slides up; "slide" would move the
    // dimmed backdrop up with it.
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {/* Sheets with fields rise above the keyboard. */}
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <Animated.View
          entering={SlideInDown.duration(280).easing(SHEET_EASE)}
          style={[
            styles.sheet,
            { backgroundColor: c.card, borderColor: c.border, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: c.border }]} />
          <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
          {description && <Text style={[styles.description, { color: c.mutedForeground }]}>{description}</Text>}
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One tappable row in a sheet or list: an optional icon, a label, a muted detail, and a trailing slot. */
export function SheetRow({
  icon,
  label,
  detail,
  selected,
  trailing,
  onPress,
  disabled,
}: {
  icon?: ReactNode;
  label: string;
  detail?: string;
  selected?: boolean;
  trailing?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        styles.row,
        (pressed || selected) && { backgroundColor: c.muted },
        disabled && styles.disabled,
      ]}
    >
      {icon}
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: c.foreground }]} numberOfLines={1}>
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
  return <Text style={[styles.section, { color: c.mutedForeground }]}>{title}</Text>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    maxHeight: "75%",
    borderTopLeftRadius: radius.xl + 4,
    borderTopRightRadius: radius.xl + 4,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 8,
  },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  title: { fontSize: 16, fontFamily: font.semibold, paddingHorizontal: 20 },
  description: { fontSize: 13, fontFamily: font.regular, paddingHorizontal: 20, marginTop: 4 },
  body: { marginTop: 10, paddingHorizontal: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 11, borderRadius: radius.md },
  rowText: { flex: 1, minWidth: 0 },
  label: { fontSize: 15, fontFamily: font.regular },
  detail: { fontSize: 12, fontFamily: font.regular, marginTop: 2 },
  section: { fontSize: 12, fontFamily: font.medium, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  disabled: { opacity: 0.5 },
});

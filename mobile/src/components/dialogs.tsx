import { type ReactNode, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/form";
import { LabelStrip } from "@/components/grid";
import { CircleCheck, OctagonX } from "@/components/icons";
import { fadeUp, zoomIn } from "@/lib/motion";
import { font, useColors } from "@/lib/theme";

// The web's AlertDialog and sonner toasts, in place of the system Alert:
// themed, edge to edge, and drawn above sheets. Callable from anywhere, like
// Alert, once <DialogHost> is mounted.

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Red confirm button, for deletes and other losses. */
  destructive?: boolean;
};
type Pending = ConfirmOptions & { resolve: (confirmed: boolean) => void };
type Toast = { id: number; title: string; description?: string; tone: "success" | "error" };

let host: { confirm: (pending: Pending) => void; toast: (toast: Omit<Toast, "id">) => void } | undefined;

/** Asks before an action; resolves true when confirmed. */
export const confirm = (options: ConfirmOptions) =>
  new Promise<boolean>((resolve) => (host ? host.confirm({ ...options, resolve }) : resolve(false)));

/** A short message at the bottom of the screen that goes away on its own. */
export const toast = {
  success: (title: string, description?: string) => host?.toast({ title, description, tone: "success" }),
  error: (title: string, description?: string) => host?.toast({ title, description, tone: "error" }),
};

const TOAST_MS = 2600;

export function DialogHost() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<Pending>();
  const [current, setCurrent] = useState<Toast>();
  const nextId = useRef(0);

  useEffect(() => {
    host = {
      // A second confirm replaces the first, which counts as cancelled.
      confirm: (next) =>
        setPending((previous) => {
          previous?.resolve(false);
          return next;
        }),
      toast: (next) => setCurrent({ ...next, id: ++nextId.current }),
    };
    return () => {
      host = undefined;
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [current]);

  const answer = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(undefined);
  };

  useEffect(() => {
    if (!pending) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      pending.resolve(false);
      setPending(undefined);
      return true;
    });
    return () => subscription.remove();
  }, [pending]);

  const Icon = current?.tone === "error" ? OctagonX : CircleCheck;
  const toneColor = current?.tone === "error" ? c.destructive : c.success;

  return (
    <>
      {pending && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(120)}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => answer(false)} accessibilityLabel="Cancel" />
          <DialogCard
            label="Confirm"
            destructive={pending.destructive}
            title={pending.title}
            actions={
              <>
                <View style={styles.action}>
                  <Button label="Cancel" variant="outline" onPress={() => answer(false)} />
                </View>
                <View style={styles.action}>
                  <Button
                    label={pending.confirmLabel ?? (pending.destructive ? "Delete" : "Continue")}
                    variant={pending.destructive ? "destructive" : "brand"}
                    onPress={() => answer(true)}
                  />
                </View>
              </>
            }
          >
            {pending.message && <Text style={[styles.message, { color: c.mutedForeground }]}>{pending.message}</Text>}
          </DialogCard>
        </Animated.View>
      )}
      {current && (
        <Animated.View
          key={current.id}
          entering={fadeUp({ rise: 12, duration: 250 })}
          exiting={FadeOut.duration(150)}
          pointerEvents="box-none"
          style={[styles.toastWrap, { bottom: insets.bottom + 16 }]}
        >
          <Pressable
            onPress={() => setCurrent(undefined)}
            accessibilityRole="alert"
            style={[styles.toast, { backgroundColor: c.card, borderColor: c.border }]}
          >
            {/* The strip's bar, in the toast's tone. */}
            <View style={[styles.toastBar, { backgroundColor: toneColor }]} />
            <Icon size={16} color={toneColor} />
            <View style={styles.toastText}>
              <Text style={[styles.toastTitle, { color: c.foreground }]}>{current.title}</Text>
              {current.description && (
                <Text style={[styles.toastDescription, { color: c.mutedForeground }]}>{current.description}</Text>
              )}
            </View>
          </Pressable>
        </Animated.View>
      )}
    </>
  );
}

/**
 * A dialog window like the web's rename and delete dialogs: a `[ LABEL ]`
 * strip (red bar for deletes), a large title, the body, and a tinted footer
 * holding the actions.
 */
export function DialogCard({
  label,
  destructive,
  title,
  children,
  actions,
}: {
  label: string;
  destructive?: boolean;
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const c = useColors();
  return (
    <Animated.View
      entering={zoomIn}
      accessibilityRole="alert"
      style={[styles.dialog, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <View style={{ backgroundColor: c.background }}>
        <LabelStrip label={label} barColor={destructive ? c.destructive : undefined} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.foreground }]}>{title}</Text>
        {children}
      </View>
      <View style={[styles.actions, { backgroundColor: c.background, borderColor: c.border }]}>{actions}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  dialog: {
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  body: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 22, gap: 10 },
  title: { fontSize: 20, lineHeight: 26, fontFamily: font.semibold, letterSpacing: -0.4 },
  message: { fontSize: 14.5, lineHeight: 21, fontFamily: font.regular },
  actions: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  action: { flex: 1 },
  toastWrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 6,
    paddingLeft: 16,
    paddingRight: 14,
    paddingVertical: 12,
    maxWidth: 420,
    width: "100%",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  toastBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2 },
  toastText: { flex: 1, minWidth: 0, gap: 2 },
  toastTitle: { fontSize: 14, fontFamily: font.medium },
  toastDescription: { fontSize: 13, fontFamily: font.regular },
});

import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { DotGrid, monoLabel } from "@/components/grid";
import { ExternalLink, Eye, Monitor, Play, RotateCcw, Smartphone, Square } from "@/components/icons";
import type { useSandbox } from "@/lib/sandbox";
import type { BootPhase } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

// The web's boot steps (preview-boot-steps.tsx).
const STEPS: Partial<Record<BootPhase, string>> = {
  create: "Create sandbox",
  files: "Write files",
  install: "Install dependencies",
  start: "Start dev server",
};
const STEP_COUNT = Object.keys(STEPS).length;

/**
 * Desktop view: the page lays out at a laptop's width and the web view zooms
 * it out to fit, by rewriting the app's viewport meta once the page loads.
 */
const DESKTOP_WIDTH = 1280;
const DESKTOP_VIEWPORT = `
  document.addEventListener("DOMContentLoaded", function () {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "viewport"; document.head.appendChild(meta); }
    meta.content = "width=${DESKTOP_WIDTH}";
  });
  true;
`;

/**
 * The project's Preview tab: the app running in its E2B sandbox, in a web view.
 * `sandbox` lives on the project screen, so switching tabs keeps it running.
 */
export function PreviewPane({
  sandbox,
  hasPackageJson,
}: {
  sandbox: ReturnType<typeof useSandbox>;
  /** Undefined while the files load. */
  hasPackageJson: boolean | undefined;
}) {
  const c = useColors();
  const [reloadKey, setReloadKey] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const { status, phase, previewUrl, error, stopped, stop, start, restart } = sandbox;
  const running = status === "running" && previewUrl;
  const step = phase ? Object.keys(STEPS).indexOf(phase) : 0;
  // Stop while it starts or runs; Start once stopped.
  const canStop = !stopped && hasPackageJson === true && status !== "error";

  const label = stopped
    ? "Stopped"
    : running
      ? "Running"
      : status === "error"
        ? "Failed to start"
        : hasPackageJson === false
          ? "Nothing to preview"
          : "Starting";

  return (
    <View style={styles.flex}>
      <View style={[styles.strip, { borderColor: c.border }]}>
        <View
          style={[
            styles.dot,
            { backgroundColor: stopped ? c.mutedForeground : running ? c.success : status === "error" ? c.destructive : c.brand },
          ]}
        />
        <Text style={[monoLabel, styles.flex, { color: c.mutedForeground }]} numberOfLines={1}>
          {label}
        </Text>
        {running && !stopped && (
          <>
            <StripButton label="Mobile view" active={!desktop} onPress={() => setDesktop(false)}>
              <Smartphone size={16} color={c.foreground} />
            </StripButton>
            <StripButton label="Desktop view" active={desktop} onPress={() => setDesktop(true)}>
              <Monitor size={16} color={c.foreground} />
            </StripButton>
            <StripButton label="Reload preview" onPress={() => setReloadKey((key) => key + 1)}>
              <RotateCcw size={16} color={c.foreground} />
            </StripButton>
            <StripButton label="Open in browser" onPress={() => WebBrowser.openBrowserAsync(previewUrl)}>
              <ExternalLink size={16} color={c.foreground} />
            </StripButton>
          </>
        )}
        {canStop && (
          <StripButton label="Stop preview" onPress={stop}>
            <Square size={14} color={c.destructive} />
          </StripButton>
        )}
        {stopped && (
          <StripButton label="Start preview" onPress={start}>
            <Play size={15} color={c.foreground} />
          </StripButton>
        )}
      </View>

      {running && !stopped ? (
        <WebView
          // A new view per reload or layout switch, so the viewport is set from the start.
          key={`${reloadKey}-${desktop}`}
          source={{ uri: previewUrl }}
          injectedJavaScriptBeforeContentLoaded={desktop ? DESKTOP_VIEWPORT : undefined}
          style={styles.flex}
        />
      ) : (
        <View style={styles.center}>
          <DotGrid />
          {stopped ? (
            <>
              <Eye size={22} color={c.mutedForeground} />
              <Text style={[styles.message, { color: c.mutedForeground }]}>The preview is stopped.</Text>
              <Pressable
                onPress={start}
                style={({ pressed }) => [styles.button, { borderColor: c.border, backgroundColor: pressed ? c.muted : c.card }]}
              >
                <Play size={14} color={c.foreground} />
                <Text style={[monoLabel, { color: c.foreground }]}>Start preview</Text>
              </Pressable>
            </>
          ) : status === "error" ? (
            <>
              <Text style={[styles.message, { color: c.destructive }]}>{error}</Text>
              <Pressable
                onPress={restart}
                style={({ pressed }) => [styles.button, { borderColor: c.border, backgroundColor: pressed ? c.muted : c.card }]}
              >
                <RotateCcw size={14} color={c.foreground} />
                <Text style={[monoLabel, { color: c.foreground }]}>Retry</Text>
              </Pressable>
            </>
          ) : hasPackageJson === false ? (
            <>
              <Eye size={22} color={c.mutedForeground} />
              <Text style={[styles.message, { color: c.mutedForeground }]}>
                Nothing to preview yet. Ask Codenaya to build something.
              </Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={c.mutedForeground} />
              <Text style={[styles.message, { color: c.foreground }]}>{STEPS[phase ?? "create"] ?? "Start dev server"}</Text>
              <Text style={[monoLabel, { color: c.mutedForeground }]}>
                Step {Math.min(step + 1, STEP_COUNT)} of {STEP_COUNT}
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function StripButton({
  label,
  onPress,
  active,
  children,
}: {
  label: string;
  onPress: () => void;
  /** The selected side of a toggle. */
  active?: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={({ pressed }) => [styles.cell, { borderColor: c.border }, (pressed || active) && { backgroundColor: c.muted }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // No gap: it would sit inside each cell's rule and push its icon off centre.
  strip: { height: 44, flexDirection: "row", alignItems: "center", paddingLeft: 16, borderBottomWidth: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 10 },
  cell: { width: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center", borderLeftWidth: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  message: { fontSize: 14, fontFamily: font.regular, textAlign: "center" },
  button: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
});

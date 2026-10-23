import { useConvexConnectionState } from "convex/react";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { font, useColors } from "@/lib/theme";

/** A short blip (the app resuming, a network switch) isn't worth a banner. */
const GRACE_MS = 3000;

/**
 * A pill at the top while Convex is unreachable, so a dropped connection
 * reads as "reconnecting" instead of a screen that silently stops updating.
 */
export function ConnectionBanner() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isWebSocketConnected } = useConvexConnectionState();
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (isWebSocketConnected) return setLost(false);
    const timer = setTimeout(() => setLost(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [isWebSocketConnected]);

  if (!lost) return null;
  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      pointerEvents="none"
      style={[styles.banner, { top: insets.top + 6, backgroundColor: c.card, borderColor: c.border }]}
    >
      <ActivityIndicator size="small" color={c.mutedForeground} />
      <Text style={[styles.text, { color: c.foreground }]}>Can't reach Codenaya. Reconnecting…</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { fontSize: 13, fontFamily: font.medium },
});

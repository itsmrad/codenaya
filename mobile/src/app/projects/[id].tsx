import { useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import type { Id } from "../../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

// The chat lands here in Phase 3.
export default function Project() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useQuery(api.projects.getById, { id: id as Id<"projects"> });

  if (project === undefined) return <ActivityIndicator style={styles.center} />;

  return (
    <View style={styles.center}>
      <Stack.Screen options={{ title: project.name }} />
      <Text style={[styles.text, { color: c.mutedForeground }]}>The chat for this project comes next.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  text: { fontSize: 14, fontFamily: font.regular, textAlign: "center" },
});

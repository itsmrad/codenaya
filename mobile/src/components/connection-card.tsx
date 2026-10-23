import type { FunctionReturnType } from "convex/server";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { getProvider } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

export type Connection = FunctionReturnType<typeof api.integrations.listUserConnections>[number];

// Tailwind's emerald-500 and amber-500, the web's status pill tints.
const STATUS = {
  active: { label: "Active", tint: "#10b981" },
  needs_reauth: { label: "Needs reauth", tint: "#f59e0b" },
  revoked: { label: "Revoked", tint: undefined },
  error: { label: "Error", tint: undefined },
};

/** Like the web's ConnectionCard: label, status, provider and credential details. */
export function ConnectionCard({ connection, children }: { connection: Connection; children?: ReactNode }) {
  const c = useColors();
  const status = STATUS[connection.status];
  const tint = status.tint ?? c.destructive;
  const provider = getProvider(connection.providerId)?.displayName ?? connection.providerId;
  const details = [
    provider,
    connection.authMode === "oauth" ? "OAuth" : "API key",
    connection.maskedPreview,
    connection.lastUsedAt ? `Used ${timeAgo(connection.lastUsedAt)}` : "Never used",
  ];
  return (
    <View style={[styles.card, { borderColor: c.border }]}>
      <View style={styles.title}>
        <Text style={[styles.label, { color: c.foreground }]} numberOfLines={1}>
          {connection.label}
        </Text>
        <Text style={[styles.pill, { color: tint, borderColor: tint }]}>{status.label}</Text>
      </View>
      <Text style={[styles.muted, { color: c.mutedForeground }]}>{details.filter(Boolean).join(" · ")}</Text>
      {connection.statusMessage && connection.status !== "active" && (
        <Text style={[styles.muted, { color: tint }]}>{connection.statusMessage}</Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  title: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { flexShrink: 1, fontSize: 14, fontFamily: font.medium },
  pill: {
    fontSize: 11,
    fontFamily: font.medium,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
  },
  muted: { fontSize: 12.5, lineHeight: 18, fontFamily: font.regular },
});

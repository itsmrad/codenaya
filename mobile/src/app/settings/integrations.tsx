import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AddConnectionSheet } from "@/components/add-connection-sheet";
import { type Connection, ConnectionCard } from "@/components/connection-card";
import { confirm, toast } from "@/components/dialogs";
import { Button } from "@/components/form";
import { Plug, Plus, Trash2 } from "@/components/icons";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { font, radius, useColors } from "@/lib/theme";

/** The web's Settings > Integrations: the user's connections, add and remove. */
export default function IntegrationsSettings() {
  const c = useColors();
  const connections = useQuery(api.integrations.listUserConnections);
  const deleteConnection = useMutation(api.integrations.deleteUserConnection);
  const [adding, setAdding] = useState(false);

  const confirmDelete = async (connection: Connection) => {
    const confirmed = await confirm({
      title: `Remove ${connection.label}?`,
      message: "It is unlinked from every project that uses it.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const { unlinkedProjects } = await deleteConnection({ id: connection._id });
      toast.success(
        `Removed ${connection.label}`,
        unlinkedProjects > 0
          ? `Unlinked from ${unlinkedProjects} ${unlinkedProjects === 1 ? "project" : "projects"}.`
          : undefined,
      );
    } catch (error) {
      toast.error(errorMessage(error, "Unable to remove this connection"));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text style={[styles.title, { color: c.foreground }]}>Connections</Text>
            <Text style={[styles.muted, { color: c.mutedForeground }]}>
              Removing a connection unlinks it from every project.
            </Text>
          </View>
          <Pressable onPress={() => setAdding(true)} hitSlop={10} accessibilityLabel="Add a connection">
            <Plus size={20} color={c.foreground} />
          </Pressable>
        </View>
        {connections === undefined ? (
          <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
        ) : connections.length === 0 ? (
          <View style={[styles.empty, { borderColor: c.border }]}>
            <Plug size={20} color={c.mutedForeground} />
            <Text style={[styles.title, { color: c.foreground }]}>No connections yet</Text>
            <Text style={[styles.muted, styles.center, { color: c.mutedForeground }]}>
              A connection gives your agent real tools using your own credentials. Link it to any of your projects.
            </Text>
            <Button label="Add a connection" icon={<Plus size={15} color={c.primaryForeground} />} onPress={() => setAdding(true)} />
          </View>
        ) : (
          connections.map((connection) => (
            <ConnectionCard key={connection._id} connection={connection}>
              <Pressable
                onPress={() => confirmDelete(connection)}
                hitSlop={10}
                accessibilityLabel={`Remove ${connection.label}`}
                style={styles.delete}
              >
                <Trash2 size={16} color={c.mutedForeground} />
              </Pressable>
            </ConnectionCard>
          ))
        )}
      </View>
      <AddConnectionSheet visible={adding} onClose={() => setAdding(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 10 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 15, fontFamily: font.semibold },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  center: { textAlign: "center" },
  loading: { paddingVertical: 16 },
  empty: { alignItems: "center", gap: 8, borderWidth: 1, borderStyle: "dashed", borderRadius: radius.lg, padding: 18 },
  delete: { alignSelf: "flex-end", marginTop: 4 },
});

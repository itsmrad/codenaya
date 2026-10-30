import { useMutation, useQuery } from "convex/react";
import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AddConnectionSheet } from "@/components/add-connection-sheet";
import { type Connection, ProviderTile, STATUS } from "@/components/connection-card";
import { confirm, toast } from "@/components/dialogs";
import { LabelStrip, monoLabel } from "@/components/grid";
import { EllipsisVertical, Plus, Trash2 } from "@/components/icons";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage, timeAgo } from "@/lib/format";
import { getProvider, listProviders } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

const providerName = (providerId: string) => getProvider(providerId)?.displayName ?? providerId;

/** The web's Settings > Integrations: the user's connections, add and remove. */
export default function IntegrationsSettings() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const connections = useQuery(api.integrations.listUserConnections);
  const deleteConnection = useMutation(api.integrations.deleteUserConnection);
  // The add sheet, open on one provider's form or on the list.
  const [adding, setAdding] = useState<{ providerId?: string }>();
  const [managingId, setManagingId] = useState<string>();
  const managing = connections?.find((connection) => connection._id === managingId);
  const connectedIds = new Set(connections?.map((connection) => connection.providerId));
  const available = listProviders().filter((provider) => !connectedIds.has(provider.id));

  const confirmDelete = async (connection: Connection) => {
    setManagingId(undefined);
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
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => setAdding({})} hitSlop={10} accessibilityLabel="Add a connection">
              <Plus size={20} color={c.foreground} />
            </Pressable>
          ),
        }}
      />
      <View style={{ backgroundColor: c.card }}>
        <LabelStrip
          label="Connections"
          cell={<Text style={[monoLabel, { color: c.mutedForeground }]}>{connections?.length ?? 0}</Text>}
        />
        {connections === undefined ? (
          <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
        ) : connections.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground, borderColor: c.border }]}>
            No connections yet. A connection gives your agent real tools using your own credentials. Link it to any of
            your projects.
          </Text>
        ) : (
          connections.map((connection) => {
            const active = connection.status === "active";
            const status = STATUS[connection.status];
            const detail = [
              connection.label,
              active
                ? connection.lastUsedAt
                  ? `Used ${timeAgo(connection.lastUsedAt)}`
                  : "Never used"
                : status.label,
            ];
            return (
              <Pressable
                key={connection._id}
                onPress={() => setManagingId(connection._id)}
                accessibilityLabel={`${connection.label} options`}
                style={({ pressed }) => [styles.row, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
              >
                <ProviderTile providerId={connection.providerId} />
                <View style={styles.flex}>
                  <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                    {providerName(connection.providerId)}
                  </Text>
                  <Text
                    style={[styles.detail, { color: active ? c.mutedForeground : (status.tint ?? c.destructive) }]}
                    numberOfLines={1}
                  >
                    {detail.join(" · ")}
                  </Text>
                </View>
                <EllipsisVertical size={18} color={c.mutedForeground} />
              </Pressable>
            );
          })
        )}
      </View>

      <View style={styles.below}>
        <Pressable
          onPress={() => setAdding({})}
          style={({ pressed }) => [
            styles.add,
            { backgroundColor: c.card, borderColor: c.border },
            pressed && { backgroundColor: c.muted },
          ]}
        >
          <Plus size={17} color={c.foreground} />
          <Text style={[styles.addText, { color: c.foreground }]}>Add a connection</Text>
        </Pressable>

        {available.length > 0 && (
          <View style={[styles.available, { borderColor: c.border }]}>
            <Text style={[monoLabel, { color: c.mutedForeground }]}>[ Available ]</Text>
            <View style={styles.chips}>
              {available.map((provider) => (
                <Pressable
                  key={provider.id}
                  onPress={() => setAdding({ providerId: provider.id })}
                  accessibilityLabel={`Add ${provider.displayName}`}
                  style={({ pressed }) => [
                    styles.chip,
                    { backgroundColor: c.card, borderColor: c.border },
                    pressed && { backgroundColor: c.muted },
                  ]}
                >
                  <Text style={[styles.chipText, { color: c.foreground }]}>{provider.displayName}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </View>

      <AddConnectionSheet
        key={adding?.providerId ?? "list"}
        visible={adding !== undefined}
        initialProviderId={adding?.providerId}
        onClose={() => setAdding(undefined)}
      />
      <Sheet
        visible={managing !== undefined}
        title={managing?.label ?? ""}
        description={
          managing &&
          [
            providerName(managing.providerId),
            managing.authMode === "oauth" ? "OAuth" : "API key",
            managing.maskedPreview,
            managing.status !== "active" && (managing.statusMessage ?? STATUS[managing.status].label),
          ]
            .filter(Boolean)
            .join(" · ")
        }
        onClose={() => setManagingId(undefined)}
      >
        {managing && (
          <SheetRow
            icon={<Trash2 size={18} color={c.destructive} />}
            label="Remove connection"
            detail="Unlinks it from every project"
            destructive
            onPress={() => confirmDelete(managing)}
          />
        )}
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { paddingVertical: 16 },
  empty: { padding: 16, borderBottomWidth: 1, fontSize: 13, lineHeight: 19, fontFamily: font.regular },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  name: { fontSize: 15, fontFamily: font.medium },
  detail: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  below: { padding: 16, gap: 16 },
  add: { height: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderWidth: 1, borderRadius: 6 },
  addText: { fontSize: 15, fontFamily: font.medium },
  available: { borderWidth: 1, borderStyle: "dashed", borderRadius: 6, padding: 16, gap: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 11, paddingVertical: 6 },
  chipText: { fontSize: 14, fontFamily: font.regular },
});

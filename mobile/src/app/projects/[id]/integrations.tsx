import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { AddConnectionSheet } from "@/components/add-connection-sheet";
import { ProviderTile, STATUS } from "@/components/connection-card";
import { LabelStrip, monoLabel } from "@/components/grid";
import { ChevronRight, ExternalLink, Eye, EyeOff, Link2, Plus, Trash2, Unlink } from "@/components/icons";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { postApi, webUrl } from "@/lib/http";
import { classifyEnvKey, getProvider, isValidEnvKey } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/**
 * A project's integrations and environment variables, like the web's project
 * connections panel and env vars dialog, as grid sections. Scopes, tool
 * filters and write approval stay on the website.
 */
export default function ProjectIntegrations() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { getToken } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = id as Id<"projects">;

  const links = useQuery(api.integrations.listProjectConnections, { projectId });
  const connections = useQuery(api.integrations.listUserConnections);
  const envVars = useQuery(api.envVars.listEnvVars, { projectId });
  const link = useMutation(api.integrations.linkConnectionToProject);
  const updateLink = useMutation(api.integrations.updateProjectConnection);
  const unlink = useMutation(api.integrations.unlinkProjectConnection);
  const setPublicEnvVar = useMutation(api.envVars.setPublicEnvVar);
  const deleteEnvVar = useMutation(api.envVars.deleteEnvVar);

  const [sheet, setSheet] = useState<"link" | "add">();
  // The linked connection whose settings sheet is open.
  const [managingId, setManagingId] = useState<string>();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [envError, setEnvError] = useState<string>();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const linkedIds = new Set(links?.map((item) => item.userConnectionId));
  const unlinked = connections?.filter((connection) => !linkedIds.has(connection._id)) ?? [];
  const managing = links?.find((item) => item._id === managingId);
  const fail = (fallback: string) => (error: unknown) => toast.error(errorMessage(error, fallback));
  const openWebsite = () => WebBrowser.openBrowserAsync(webUrl(`/projects/${projectId}`));

  const linkConnection = (userConnectionId: Id<"userConnections">, label: string) => {
    setSheet(undefined);
    // No readOnly argument: a new link is read-only with writes unapproved, as on the web.
    link({ projectId, userConnectionId }).then(
      () => toast.success(`Linked ${label}`, "Read-only until you allow writes."),
      fail("Unable to link this connection"),
    );
  };

  /** Public variables go to Convex; secrets are sealed by the web's route. */
  const saveEnvVar = async () => {
    const trimmed = key.trim();
    if (!isValidEnvKey(trimmed)) return setEnvError("Use letters, digits and underscores only");
    if (!value) return setEnvError("Value is required");
    setSaving(true);
    setEnvError(undefined);
    try {
      if (classifyEnvKey(trimmed) === "public") {
        await setPublicEnvVar({ projectId, key: trimmed, value });
      } else {
        const { ok, data } = await postApi("/api/env-vars", { projectId, key: trimmed, value }, getToken);
        if (!ok) throw new Error(data.error ?? `Unable to save ${trimmed}`);
      }
      setKey("");
      setValue("");
    } catch (error) {
      setEnvError(errorMessage(error, `Unable to save ${trimmed}`));
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = (envKey: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(envKey)) next.delete(envKey);
      else next.add(envKey);
      return next;
    });

  const typed = key.trim();
  const isPublicKey = classifyEnvKey(typed) === "public";
  const envNote = envError ?? (typed ? `Saved as ${isPublicKey ? "public" : "an encrypted secret"}` : undefined);
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
        <View style={{ backgroundColor: c.card }}>
          <LabelStrip
            label="Connections"
            cell={
              <Pressable
                onPress={() => setSheet("link")}
                hitSlop={12}
                accessibilityLabel="Link a connection"
                style={({ pressed }) => [styles.cellButton, pressed && styles.dim]}
              >
                <Link2 size={15} color={c.foreground} />
                <Text style={[monoLabel, { color: c.foreground }]}>Link</Text>
              </Pressable>
            }
          />
        </View>
        <View style={styles.cards}>
          {links === undefined ? (
            <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
          ) : links.length === 0 ? (
            <Text style={[styles.empty, { color: c.mutedForeground }]}>
              No connections linked to this project. New links are read-only.
            </Text>
          ) : (
            links.map((item) => {
              const status = STATUS[item.connection.status];
              const detail = [item.connection.label, item.connection.status !== "active" && status.label];
              return (
                <View key={item._id} style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
                  <View style={styles.cardTop}>
                    <ProviderTile providerId={item.connection.providerId} />
                    <View style={styles.flex}>
                      <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                        {getProvider(item.connection.providerId)?.displayName ?? item.connection.providerId}
                      </Text>
                      <Text
                        style={[
                          styles.detail,
                          { color: item.connection.status === "active" ? c.mutedForeground : (status.tint ?? c.destructive) },
                        ]}
                        numberOfLines={1}
                      >
                        {detail.filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <Switch
                      value={item.enabled}
                      onValueChange={(enabled) => {
                        updateLink({ id: item._id, enabled }).catch(fail("Unable to update this connection"));
                      }}
                      trackColor={{ true: c.brand }}
                      accessibilityLabel={`${item.connection.label} enabled`}
                    />
                  </View>
                  <Pressable
                    onPress={() => setManagingId(item._id)}
                    accessibilityLabel={`${item.connection.label} settings`}
                    style={({ pressed }) => [styles.cardBottom, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
                  >
                    <Text
                      style={[
                        monoLabel,
                        styles.tag,
                        item.readOnly
                          ? { color: c.mutedForeground, borderColor: c.border }
                          : { color: c.brandText, borderColor: c.brand },
                      ]}
                    >
                      {item.readOnly ? "Read-only" : "Read and write"}
                    </Text>
                    <Text style={[styles.note, { color: c.mutedForeground }]} numberOfLines={1}>
                      {!item.readOnly && !item.writeApproved
                        ? "Writes need approval"
                        : item.toolCount !== undefined
                          ? `${item.toolCount} tools`
                          : ""}
                    </Text>
                    <ChevronRight size={16} color={c.mutedForeground} />
                  </Pressable>
                </View>
              );
            })
          )}
          {links && links.length > 0 && (
            <Pressable onPress={openWebsite} hitSlop={6} style={({ pressed }) => [styles.website, pressed && styles.dim]}>
              <Text style={[styles.note, { color: c.mutedForeground }]}>Scope and tools on the website</Text>
              <ExternalLink size={14} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>

        <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
          <LabelStrip
            label="Environment variables"
            cell={<Text style={[monoLabel, { color: c.mutedForeground }]}>{envVars?.length ?? 0}</Text>}
          />
          {envVars === undefined ? (
            <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
          ) : envVars.length === 0 ? (
            <Text style={[styles.empty, styles.rule, { color: c.mutedForeground, borderColor: c.border }]}>
              No variables yet.
            </Text>
          ) : (
            envVars.map((envVar) => {
              const isPublic = envVar.visibility === "public";
              const shown = isPublic && revealed.has(envVar.key) ? envVar.value : envVar.maskedPreview;
              return (
                <View key={envVar._id} style={[styles.envRow, { borderColor: c.border }]}>
                  <View style={styles.flex}>
                    <View style={styles.envTitle}>
                      <Text style={[styles.envKey, { color: c.foreground }]} numberOfLines={1}>
                        {envVar.key}
                      </Text>
                      {envVar.source === "integration" && (
                        <Text style={[monoLabel, styles.tag, { color: c.mutedForeground, borderColor: c.border }]}>
                          Integration
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.envValue, { color: c.mutedForeground }]} numberOfLines={1}>
                      {shown}
                    </Text>
                  </View>
                  {isPublic && (
                    <Pressable
                      onPress={() => toggleReveal(envVar.key)}
                      hitSlop={8}
                      accessibilityLabel={`${revealed.has(envVar.key) ? "Hide" : "Reveal"} ${envVar.key}`}
                    >
                      {revealed.has(envVar.key) ? (
                        <EyeOff size={17} color={c.mutedForeground} />
                      ) : (
                        <Eye size={17} color={c.mutedForeground} />
                      )}
                    </Pressable>
                  )}
                  <Pressable
                    onPress={async () => {
                      const confirmed = await confirm({
                        title: `Delete ${envVar.key}?`,
                        message: "The agent and the preview lose this variable.",
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (confirmed) deleteEnvVar({ id: envVar._id }).catch(() => toast.error(`Unable to delete ${envVar.key}`));
                    }}
                    hitSlop={8}
                    accessibilityLabel={`Delete ${envVar.key}`}
                  >
                    <Trash2 size={17} color={c.mutedForeground} />
                  </Pressable>
                </View>
              );
            })
          )}
          <View style={styles.addRow}>
            <TextInput
              value={key}
              onChangeText={setKey}
              placeholder="NEXT_PUBLIC_API_URL"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Key"
              style={[styles.input, styles.keyInput, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]}
            />
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder="Value"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!isPublicKey}
              accessibilityLabel="Value"
              style={[styles.input, styles.flex, { color: c.foreground, borderColor: c.border, backgroundColor: c.background }]}
            />
            <Pressable
              onPress={saveEnvVar}
              disabled={!typed || !value || saving}
              accessibilityLabel="Save variable"
              style={({ pressed }) => [
                styles.addButton,
                { backgroundColor: c.brand },
                (!typed || !value) && styles.disabled,
                pressed && styles.dim,
              ]}
            >
              {saving ? <ActivityIndicator size="small" color={c.brandForeground} /> : <Plus size={18} color={c.brandForeground} />}
            </Pressable>
          </View>
          {envNote && (
            <Text style={[styles.envNote, { color: envError ? c.destructive : c.mutedForeground }]}>{envNote}</Text>
          )}
        </View>
      </ScrollView>

      <Sheet visible={sheet === "link"} title="Link a connection" onClose={() => setSheet(undefined)}>
        {unlinked.length === 0 && (
          <Text style={[styles.empty, { color: c.mutedForeground }]}>
            {connections?.length ? "Every connection in your account is already linked." : "No connections yet."}
          </Text>
        )}
        {unlinked.map((connection) => (
          <SheetRow
            key={connection._id}
            icon={<ProviderTile providerId={connection.providerId} />}
            label={connection.label}
            detail={getProvider(connection.providerId)?.displayName ?? connection.providerId}
            trailing={<Link2 size={16} color={c.mutedForeground} />}
            onPress={() => linkConnection(connection._id, connection.label)}
          />
        ))}
        <SheetRow
          label="Add a new connection"
          trailing={<Plus size={16} color={c.mutedForeground} />}
          onPress={() => setSheet("add")}
        />
      </Sheet>
      <AddConnectionSheet visible={sheet === "add"} projectId={projectId} onClose={() => setSheet(undefined)} />

      <Sheet
        visible={managing !== undefined}
        title={managing?.connection.label ?? ""}
        onClose={() => setManagingId(undefined)}
      >
        {managing && (getProvider(managing.connection.providerId)?.supportsReadOnly ?? false) && (
          <SheetRow
            label="Read-only"
            detail="The agent can read but not change anything"
            trailing={
              <Switch
                value={managing.readOnly}
                onValueChange={(readOnly) => {
                  updateLink({ id: managing._id, readOnly }).catch(fail("Unable to update this connection"));
                }}
                trackColor={{ true: c.brand }}
              />
            }
          />
        )}
        <SheetRow
          label="Scope and tools on the website"
          trailing={<ExternalLink size={16} color={c.mutedForeground} />}
          onPress={openWebsite}
        />
        {managing && (
          <SheetRow
            label="Unlink"
            destructive
            trailing={<Unlink size={16} color={c.destructive} />}
            onPress={() => {
              setManagingId(undefined);
              unlink({ id: managing._id }).catch(fail("Unable to unlink this connection"));
            }}
          />
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dim: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  loading: { paddingVertical: 16 },
  empty: { textAlign: "center", paddingVertical: 16, fontSize: 13, fontFamily: font.regular },
  rule: { borderBottomWidth: 1 },
  cellButton: { flexDirection: "row", alignItems: "center", gap: 8 },
  cards: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  name: { fontSize: 15, fontFamily: font.medium },
  detail: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  cardBottom: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
  note: { flex: 1, fontSize: 13, fontFamily: font.regular },
  website: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  section: { borderTopWidth: 1, borderBottomWidth: 1 },
  envRow: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  envTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  envKey: { flexShrink: 1, fontSize: 13, fontFamily: font.monoMedium },
  envValue: { fontSize: 12, fontFamily: font.mono, marginTop: 3 },
  addRow: { flexDirection: "row", gap: 8, padding: 16 },
  input: { height: 44, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 12, fontFamily: font.mono },
  keyInput: { flex: 1.15 },
  addButton: { width: 44, height: 44, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  envNote: { marginTop: -8, paddingHorizontal: 16, paddingBottom: 14, fontSize: 12, fontFamily: font.regular },
});

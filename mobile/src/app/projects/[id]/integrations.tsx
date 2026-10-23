import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as WebBrowser from "expo-web-browser";
import { Eye, EyeOff, Link2, Plus, Trash2, Unlink } from "lucide-react-native";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { AddConnectionSheet } from "@/components/add-connection-sheet";
import { ConnectionCard } from "@/components/connection-card";
import { Button, Field } from "@/components/form";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { postApi, webUrl } from "@/lib/http";
import { classifyEnvKey, getProvider, isValidEnvKey } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

function SwitchRow({
  label,
  value,
  onChange,
  c,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  c: Colors;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={[styles.switchLabel, { color: c.foreground }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: c.brand }} />
    </View>
  );
}

/**
 * A project's integrations and environment variables, like the web's project
 * connections panel and env vars dialog. Scopes, tool filters and write
 * approval stay on the website.
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
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [envError, setEnvError] = useState<string>();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const linkedIds = new Set(links?.map((item) => item.userConnectionId));
  const unlinked = connections?.filter((connection) => !linkedIds.has(connection._id)) ?? [];
  const fail = (fallback: string) => (error: unknown) => toast.error(errorMessage(error, fallback));

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
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          <View style={styles.header}>
            <View style={styles.flex}>
              <Text style={[styles.title, { color: c.foreground }]}>Connections</Text>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>
                Tools your agent can use in this project. New links are read-only.
              </Text>
            </View>
            <Pressable onPress={() => setSheet("link")} hitSlop={10} accessibilityLabel="Link a connection">
              <Plus size={20} color={c.foreground} />
            </Pressable>
          </View>
          {links === undefined ? (
            <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
          ) : links.length === 0 ? (
            <Text style={[styles.empty, { color: c.mutedForeground }]}>No connections linked to this project.</Text>
          ) : (
            links.map((item) => {
              const supportsReadOnly = getProvider(item.connection.providerId)?.supportsReadOnly ?? false;
              return (
                <ConnectionCard key={item._id} connection={item.connection}>
                  <Text style={[styles.muted, { color: c.mutedForeground }]}>
                    {item.readOnly ? "Read-only" : item.writeApproved ? "Read and write" : "Writes need approval"}
                    {item.toolCount !== undefined && ` · ${item.toolCount} tools`}
                  </Text>
                  <SwitchRow
                    label="Enabled"
                    value={item.enabled}
                    onChange={(enabled) => {
                      updateLink({ id: item._id, enabled }).catch(fail("Unable to update this connection"));
                    }}
                    c={c}
                  />
                  {supportsReadOnly && (
                    <SwitchRow
                      label="Read-only"
                      value={item.readOnly}
                      onChange={(readOnly) => {
                        updateLink({ id: item._id, readOnly }).catch(fail("Unable to update this connection"));
                      }}
                      c={c}
                    />
                  )}
                  <View style={styles.linkActions}>
                    <Pressable
                      onPress={() => WebBrowser.openBrowserAsync(webUrl(`/projects/${projectId}`))}
                      hitSlop={6}
                    >
                      <Text style={[styles.link, { color: c.brandText }]}>Scope and tools on the website</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => unlink({ id: item._id }).catch(fail("Unable to unlink this connection"))}
                      hitSlop={10}
                      accessibilityLabel={`Unlink ${item.connection.label}`}
                    >
                      <Unlink size={16} color={c.mutedForeground} />
                    </Pressable>
                  </View>
                </ConnectionCard>
              );
            })
          )}
        </View>

        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.title, { color: c.foreground }]}>Environment variables</Text>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>
            Keys starting with NEXT_PUBLIC_, VITE_ or PUBLIC_ are public. Anything else is an encrypted secret that is
            never shown again.
          </Text>
          {envVars === undefined ? (
            <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
          ) : envVars.length === 0 ? (
            <Text style={[styles.empty, { color: c.mutedForeground }]}>No variables yet.</Text>
          ) : (
            envVars.map((envVar) => {
              const isPublic = envVar.visibility === "public";
              const shown = isPublic && revealed.has(envVar.key) ? envVar.value : envVar.maskedPreview;
              return (
                <View key={envVar._id} style={[styles.envRow, { borderColor: c.border }]}>
                  <View style={styles.flex}>
                    <Text style={[styles.envKey, { color: c.foreground }]} numberOfLines={1}>
                      {envVar.key}
                    </Text>
                    <Text style={[styles.envValue, { color: c.mutedForeground }]} numberOfLines={1}>
                      {shown} · {isPublic ? "public" : "secret"}
                      {envVar.source === "integration" && " · from an integration"}
                    </Text>
                  </View>
                  {isPublic && (
                    <Pressable
                      onPress={() => toggleReveal(envVar.key)}
                      hitSlop={8}
                      accessibilityLabel={`${revealed.has(envVar.key) ? "Hide" : "Reveal"} ${envVar.key}`}
                    >
                      {revealed.has(envVar.key) ? (
                        <EyeOff size={16} color={c.mutedForeground} />
                      ) : (
                        <Eye size={16} color={c.mutedForeground} />
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
                    <Trash2 size={16} color={c.mutedForeground} />
                  </Pressable>
                </View>
              );
            })
          )}
          <Field
            label="Key"
            value={key}
            onChangeText={setKey}
            placeholder="NEXT_PUBLIC_API_URL"
            autoCapitalize="characters"
            style={styles.mono}
            hint={typed ? `Saved as ${classifyEnvKey(typed) === "public" ? "public" : "an encrypted secret"}` : undefined}
          />
          <Field label="Value" value={value} onChangeText={setValue} placeholder="Value" secureTextEntry={classifyEnvKey(typed) !== "public"} />
          {envError && <Text style={[styles.muted, { color: c.destructive }]}>{envError}</Text>}
          <Button label="Save variable" busy={saving} disabled={!typed || !value} onPress={saveEnvVar} />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 14 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 10 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 15, fontFamily: font.semibold },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  empty: { textAlign: "center", paddingVertical: 12, fontSize: 13, fontFamily: font.regular },
  loading: { paddingVertical: 16 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { fontSize: 13, fontFamily: font.regular },
  linkActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  link: { fontSize: 12.5, fontFamily: font.medium },
  envRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  envKey: { fontSize: 13, fontFamily: "monospace" },
  envValue: { fontSize: 12, fontFamily: font.regular, marginTop: 2 },
  mono: { fontFamily: "monospace" },
});

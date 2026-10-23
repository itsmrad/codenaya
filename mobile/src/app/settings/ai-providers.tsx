import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, ChevronDown, KeyRound, Plus, Trash2, Wallet } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AddProviderKeySheet } from "@/components/add-provider-key-sheet";
import { Button } from "@/components/form";
import { Sheet, SheetRow, SheetSection } from "@/components/sheet";
import { useAgentModel } from "@/lib/agent-model";
import { api } from "@/lib/api";
import { errorMessage, timeAgo } from "@/lib/format";
import { postApi } from "@/lib/http";
import { AI_PROVIDERS } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

type ProviderKey = FunctionReturnType<typeof api.aiProviders.list>[number];

/** Tailwind's emerald-500, the web's "Active" badge. */
const SUCCESS = "#10b981";

/** Like the web's ProviderKeyCard: status, masked key, test and delete. */
function KeyCard({ providerKey, c }: { providerKey: ProviderKey; c: Colors }) {
  const { getToken } = useAuth();
  const removeKey = useMutation(api.aiProviders.remove);
  const [testing, setTesting] = useState(false);
  const { label, provider, maskedPreview, status, lastTestedAt, baseUrl } = providerKey;
  const providerLabel = AI_PROVIDERS[provider].label;
  const tint = status === "active" ? SUCCESS : c.destructive;

  const test = async () => {
    setTesting(true);
    try {
      // The new status and test time arrive through the live list query.
      const { ok, data } = await postApi(`/api/ai-providers/${providerKey._id}/test`, {}, getToken);
      Alert.alert(ok ? `${label} is working` : (data.error ?? "Something went wrong. Please try again."));
    } catch {
      Alert.alert("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setTesting(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert(
      `Delete ${label}?`,
      "The stored key is deleted and cannot be recovered. If it is your default, new runs go back to Codenaya's models.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            removeKey({ keyId: providerKey._id }).catch((error) =>
              Alert.alert(errorMessage(error, "Unable to remove this key")),
            ),
        },
      ],
    );

  return (
    <View style={[styles.key, { borderColor: c.border }]}>
      <View style={styles.keyTitle}>
        <Text style={[styles.keyLabel, { color: c.foreground }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.badge, { color: tint, borderColor: tint }]}>{status === "active" ? "Active" : "Invalid"}</Text>
      </View>
      <Text style={[styles.muted, { color: c.mutedForeground }]}>
        {providerLabel} · <Text style={styles.mono}>{maskedPreview}</Text>
        {lastTestedAt !== undefined && ` · Tested ${timeAgo(lastTestedAt)}`}
      </Text>
      {baseUrl && (
        <Text style={[styles.muted, styles.mono, { color: c.mutedForeground }]} numberOfLines={1}>
          {baseUrl}
        </Text>
      )}
      {status === "invalid" && (
        <Text style={[styles.muted, { color: c.destructive }]}>
          {providerLabel} rejected this key. Runs that use it fail until you replace it.
        </Text>
      )}
      <View style={styles.keyActions}>
        <Button label={testing ? "Testing..." : "Test"} variant="outline" busy={testing} onPress={test} />
        <Pressable onPress={confirmDelete} hitSlop={10} accessibilityLabel={`Delete ${label}`}>
          <Trash2 size={17} color={c.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The web's AI providers settings: bring-your-own keys and the default model
 * new runs start with.
 */
export default function AiProvidersSettings() {
  const c = useColors();
  const keys = useQuery(api.aiProviders.list);
  const preferences = useQuery(api.aiProviders.getPreferences);
  const setPreferences = useMutation(api.aiProviders.setPreferences);
  const { groups } = useAgentModel();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);

  const isDefault = (keyId: string | undefined, modelId: string) =>
    preferences?.defaultModelId === modelId && (preferences.defaultKeyId ?? undefined) === keyId;
  const current = groups
    .flatMap((group) => group.models.map((model) => ({ group, model })))
    .find(({ group, model }) => isDefault(group.keyId, model.id));

  const pick = (keyId: ProviderKey["_id"] | undefined, modelId: string) => {
    setPicking(false);
    setPreferences({ defaultKeyId: keyId, defaultModelId: modelId }).catch(() =>
      Alert.alert("Could not update the default model"),
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.card, styles.notice, { backgroundColor: c.card, borderColor: c.border }]}>
        <Wallet size={16} color={c.foreground} />
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.foreground }]}>Using your own key consumes no Codenaya credits</Text>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>
            The provider bills you directly. If a key stops working, runs that use it fail with a link back here.
            Codenaya never falls back to its own key.
          </Text>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={styles.cardHeader}>
          <View style={styles.flex}>
            <Text style={[styles.title, { color: c.foreground }]}>API keys</Text>
            <Text style={[styles.muted, { color: c.mutedForeground }]}>
              Keys are encrypted at rest. Only the last four characters are ever shown.
            </Text>
          </View>
          {keys && keys.length > 0 && (
            <Pressable onPress={() => setAdding(true)} hitSlop={10} accessibilityLabel="Add key">
              <Plus size={20} color={c.foreground} />
            </Pressable>
          )}
        </View>
        {keys === undefined ? (
          <ActivityIndicator style={styles.loading} />
        ) : keys.length === 0 ? (
          <View style={[styles.empty, { borderColor: c.border }]}>
            <KeyRound size={20} color={c.mutedForeground} />
            <Text style={[styles.title, { color: c.foreground }]}>No API keys yet</Text>
            <Text style={[styles.muted, styles.center, { color: c.mutedForeground }]}>
              Add a key from OpenRouter, OpenAI, Anthropic or any OpenAI-compatible endpoint to run your agent on it.
            </Text>
            <Button label="Add key" icon={<Plus size={15} color={c.primaryForeground} />} onPress={() => setAdding(true)} />
          </View>
        ) : (
          keys.map((key) => <KeyCard key={key._id} providerKey={key} c={c} />)
        )}
      </View>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.foreground }]}>Default model</Text>
        <Text style={[styles.muted, { color: c.mutedForeground }]}>The model new agent runs start with.</Text>
        <Pressable
          onPress={() => setPicking(true)}
          disabled={!preferences}
          style={[styles.select, { borderColor: c.border, backgroundColor: c.background }]}
        >
          <Text style={[styles.selectText, { color: c.foreground }]} numberOfLines={1}>
            {current ? `${current.group.title} · ${current.model.label}` : (preferences?.defaultModelId ?? "Loading...")}
          </Text>
          <ChevronDown size={16} color={c.mutedForeground} />
        </Pressable>
      </View>

      <AddProviderKeySheet visible={adding} onClose={() => setAdding(false)} />
      <Sheet visible={picking} title="Default model" onClose={() => setPicking(false)}>
        {groups.map((group) => (
          <View key={group.keyId ?? "platform"}>
            <SheetSection title={group.title} />
            {group.models.map((model) => {
              const selected = isDefault(group.keyId, model.id);
              return (
                <SheetRow
                  key={model.id}
                  label={model.label}
                  selected={selected}
                  trailing={selected ? <Check size={16} color={c.brand} /> : undefined}
                  onPress={() => pick(group.keyId, model.id)}
                />
              );
            })}
          </View>
        ))}
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 14 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 10 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 15, fontFamily: font.semibold },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  mono: { fontFamily: "monospace" },
  center: { textAlign: "center" },
  loading: { paddingVertical: 16 },
  empty: { alignItems: "center", gap: 8, borderWidth: 1, borderStyle: "dashed", borderRadius: radius.lg, padding: 18 },
  key: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  keyTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  keyLabel: { flexShrink: 1, fontSize: 14, fontFamily: font.medium },
  badge: {
    fontSize: 11,
    fontFamily: font.medium,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: "hidden",
  },
  keyActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  select: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  selectText: { flex: 1, fontSize: 14, fontFamily: font.regular },
});

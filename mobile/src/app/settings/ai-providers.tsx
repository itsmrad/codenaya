import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { confirm, toast } from "@/components/dialogs";
import { AddProviderKeySheet } from "@/components/add-provider-key-sheet";
import { LabelStrip, monoLabel } from "@/components/grid";
import { BadgeCheck, Check, ChevronsUpDown, FlaskConical, Plus, Sparkles, Trash2 } from "@/components/icons";
import { Sheet, SheetRow, SheetSection } from "@/components/sheet";
import { useAgentModel } from "@/lib/agent-model";
import { api } from "@/lib/api";
import { errorMessage, timeAgo } from "@/lib/format";
import { postApi } from "@/lib/http";
import { AI_PROVIDERS } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

type ProviderKey = FunctionReturnType<typeof api.aiProviders.list>[number];

/** Like the web's ProviderKeyCard's details and actions, in a sheet: test and delete. */
function KeySheet({ providerKey, onClose }: { providerKey: ProviderKey | undefined; onClose: () => void }) {
  const c = useColors();
  const { getToken } = useAuth();
  const removeKey = useMutation(api.aiProviders.remove);
  const [testing, setTesting] = useState(false);

  const details = providerKey && [
    AI_PROVIDERS[providerKey.provider].label,
    providerKey.maskedPreview,
    providerKey.lastTestedAt !== undefined && `Tested ${timeAgo(providerKey.lastTestedAt)}`,
    providerKey.baseUrl,
  ];
  const description =
    providerKey?.status === "invalid"
      ? `${AI_PROVIDERS[providerKey.provider].label} rejected this key. Runs that use it fail until you replace it.`
      : details?.filter(Boolean).join(" · ");

  const test = async () => {
    if (!providerKey) return;
    setTesting(true);
    try {
      // The new status and test time arrive through the live list query.
      const { ok, data } = await postApi(`/api/ai-providers/${providerKey._id}/test`, {}, getToken);
      if (ok) toast.success(`${providerKey.label} is working`);
      else toast.error(data.error ?? "Something went wrong. Please try again.");
    } catch {
      toast.error("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setTesting(false);
    }
  };

  const confirmDelete = async () => {
    if (!providerKey) return;
    onClose();
    const confirmed = await confirm({
      title: `Delete ${providerKey.label}?`,
      message: "The stored key is deleted and cannot be recovered. If it is your default, new runs go back to Codenaya's models.",
      confirmLabel: "Delete key",
      destructive: true,
    });
    if (!confirmed) return;
    removeKey({ keyId: providerKey._id }).catch((error) => toast.error(errorMessage(error, "Unable to remove this key")));
  };

  return (
    <Sheet visible={providerKey !== undefined} title={providerKey?.label ?? ""} description={description} onClose={onClose}>
      <SheetRow
        icon={<FlaskConical size={18} color={c.foreground} />}
        label={testing ? "Testing..." : "Test key"}
        disabled={testing}
        trailing={testing ? <ActivityIndicator size="small" color={c.mutedForeground} /> : undefined}
        onPress={test}
      />
      <SheetRow icon={<Trash2 size={18} color={c.destructive} />} label="Delete key" destructive onPress={confirmDelete} />
    </Sheet>
  );
}

/**
 * The web's AI providers settings: the default model new runs start with and
 * bring-your-own keys, as grid sections.
 */
export default function AiProvidersSettings() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const keys = useQuery(api.aiProviders.list);
  const preferences = useQuery(api.aiProviders.getPreferences);
  const setPreferences = useMutation(api.aiProviders.setPreferences);
  const { groups } = useAgentModel();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [managingId, setManagingId] = useState<string>();

  const isDefault = (keyId: string | undefined, modelId: string) =>
    preferences?.defaultModelId === modelId && (preferences.defaultKeyId ?? undefined) === keyId;
  const current = groups
    .flatMap((group) => group.models.map((model) => ({ group, model })))
    .find(({ group, model }) => isDefault(group.keyId, model.id));

  const pick = (keyId: ProviderKey["_id"] | undefined, modelId: string) => {
    setPicking(false);
    setPreferences({ defaultKeyId: keyId, defaultModelId: modelId }).catch(() =>
      toast.error("Could not update the default model"),
    );
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={[styles.section, styles.first, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip label="Default model" />
        <View style={styles.body}>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>The model new agent runs start with.</Text>
          <Pressable
            onPress={() => setPicking(true)}
            disabled={!preferences}
            accessibilityLabel="Default model"
            style={({ pressed }) => [
              styles.select,
              { borderColor: c.border, backgroundColor: c.background },
              pressed && { backgroundColor: c.muted },
            ]}
          >
            <Sparkles size={17} color={c.mutedForeground} />
            <View style={styles.flex}>
              <Text style={[styles.selectText, { color: c.foreground }]} numberOfLines={1}>
                {current ? current.model.label : (preferences?.defaultModelId ?? "Loading...")}
              </Text>
              {current && (
                <Text style={[monoLabel, styles.selectGroup, { color: c.mutedForeground }]} numberOfLines={1}>
                  {current.group.title}
                </Text>
              )}
            </View>
            <ChevronsUpDown size={16} color={c.mutedForeground} />
          </Pressable>
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip
          label="API keys"
          cell={
            <Pressable
              onPress={() => setAdding(true)}
              hitSlop={12}
              accessibilityLabel="Add key"
              style={({ pressed }) => [styles.cellButton, pressed && styles.dim]}
            >
              <Plus size={15} color={c.foreground} />
              <Text style={[monoLabel, { color: c.foreground }]}>Add key</Text>
            </Pressable>
          }
        />
        <View style={[styles.notice, { backgroundColor: `${c.brand}12` }]}>
          <BadgeCheck size={16} color={c.brandText} />
          <Text style={[styles.noticeText, { color: c.brandText }]}>Using your own key consumes no Codenaya credits</Text>
        </View>
        {keys === undefined ? (
          <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
        ) : keys.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground, borderColor: c.border }]}>
            No API keys yet. Add a key from OpenRouter, OpenAI, Anthropic or any OpenAI-compatible endpoint to run your
            agent on it.
          </Text>
        ) : (
          keys.map((key) => {
            const provider = AI_PROVIDERS[key.provider].label;
            const active = key.status === "active";
            return (
              <Pressable
                key={key._id}
                onPress={() => setManagingId(key._id)}
                accessibilityLabel={`${provider} · ${key.label}`}
                style={({ pressed }) => [styles.keyRow, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
              >
                <View style={[styles.tile, { borderColor: c.border, backgroundColor: c.background }]}>
                  <Text style={[styles.initial, { color: c.foreground }]}>{provider[0]}</Text>
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.keyLabel, { color: c.foreground }]} numberOfLines={1}>
                    {provider} · {key.label}
                  </Text>
                  <Text style={[styles.masked, { color: c.mutedForeground }]} numberOfLines={1}>
                    {key.maskedPreview}
                  </Text>
                </View>
                <Text
                  style={[
                    monoLabel,
                    styles.tag,
                    active
                      ? { color: c.success, borderColor: `${c.success}55` }
                      : { color: c.destructive, borderColor: `${c.destructive}55` },
                  ]}
                >
                  {active ? "Active" : "Invalid"}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      <AddProviderKeySheet visible={adding} onClose={() => setAdding(false)} />
      <KeySheet providerKey={keys?.find((key) => key._id === managingId)} onClose={() => setManagingId(undefined)} />
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
  dim: { opacity: 0.6 },
  loading: { paddingVertical: 16 },
  section: { marginTop: 20, borderTopWidth: 1, borderBottomWidth: 1 },
  // Straight under the header, as in the mockup.
  first: { marginTop: 0, borderTopWidth: 0 },
  body: { padding: 16, gap: 12 },
  muted: { fontSize: 14, lineHeight: 20, fontFamily: font.regular },
  select: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  selectText: { fontSize: 15, fontFamily: font.medium },
  selectGroup: { fontSize: 9, marginTop: 3 },
  cellButton: { flexDirection: "row", alignItems: "center", gap: 8 },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  noticeText: { flex: 1, fontSize: 13.5, fontFamily: font.regular },
  empty: { padding: 16, borderTopWidth: 1, fontSize: 13, lineHeight: 19, fontFamily: font.regular },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  tile: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  initial: { fontSize: 13, fontFamily: font.monoMedium },
  keyLabel: { fontSize: 15, fontFamily: font.medium },
  masked: { fontSize: 12, fontFamily: font.mono, marginTop: 3 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
});

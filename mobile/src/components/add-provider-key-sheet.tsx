import { useAuth } from "@clerk/expo";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Button, Field } from "@/components/form";
import { Sheet } from "@/components/sheet";
import { postApi } from "@/lib/http";
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProviderId, MAX_CUSTOM_MODEL_IDS } from "@/lib/shared";
import { font, radius, useColors } from "@/lib/theme";

/** Model ids entered one per line (commas also work), as on the web. */
const parseModelIds = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

const isUrl = (value: string) => {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
};

/**
 * The web's Add an API key dialog: the route tests the key with the provider,
 * then stores it encrypted. Closing drops the typed key.
 */
export function AddProviderKeySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { getToken } = useAuth();
  const [provider, setProvider] = useState<AiProviderId>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const custom = provider === "custom";

  const close = () => {
    setApiKey("");
    setLabel("");
    setBaseUrl("");
    setModelIds("");
    setError(undefined);
    onClose();
  };

  const add = async () => {
    const ids = parseModelIds(modelIds);
    if (!apiKey.trim()) return setError("An API key is required");
    if (custom && !isUrl(baseUrl.trim())) return setError("Enter a full URL, for example https://api.example.com/v1");
    if (custom && (ids.length === 0 || ids.length > MAX_CUSTOM_MODEL_IDS)) {
      return setError(`Enter between 1 and ${MAX_CUSTOM_MODEL_IDS} model ids`);
    }
    setBusy(true);
    setError(undefined);
    try {
      const { ok, data } = await postApi(
        "/api/ai-providers",
        {
          provider,
          apiKey: apiKey.trim(),
          label: label.trim() || AI_PROVIDERS[provider].label,
          baseUrl: custom ? baseUrl.trim() : undefined,
          modelIds: custom ? ids : undefined,
        },
        getToken,
      );
      if (ok) close();
      else setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title="Add an API key"
      description="We test the key with the provider before saving it, then store it encrypted."
      onClose={close}
    >
      <View style={styles.form}>
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.foreground }]}>Provider</Text>
          <View style={styles.providers}>
            {AI_PROVIDER_IDS.map((id) => {
              const selected = id === provider;
              return (
                <Pressable
                  key={id}
                  onPress={() => setProvider(id)}
                  accessibilityState={{ selected }}
                  style={[
                    styles.provider,
                    { borderColor: selected ? c.foreground : c.border, backgroundColor: selected ? c.muted : undefined },
                  ]}
                >
                  <Text style={[styles.providerText, { color: selected ? c.foreground : c.mutedForeground }]}>
                    {AI_PROVIDERS[id].label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {custom && (
          <>
            <Field
              label="Base URL"
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.example.com/v1"
              keyboardType="url"
              hint="An OpenAI-compatible API root, the part before /chat/completions."
            />
            <Field
              label="Model ids"
              value={modelIds}
              onChangeText={setModelIds}
              placeholder={"llama-3.3-70b\nqwen-2.5-coder"}
              multiline
              hint={`One per line, up to ${MAX_CUSTOM_MODEL_IDS}. Pick models that support tool calling.`}
            />
          </>
        )}
        <Field
          label="API key"
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="Paste your API key"
          secureTextEntry
        />
        <Field
          label="Label (optional)"
          value={label}
          onChangeText={setLabel}
          placeholder={AI_PROVIDERS[provider].label}
          autoCapitalize="sentences"
        />
        {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
        <Button label={busy ? "Testing key..." : "Add key"} busy={busy} onPress={add} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14, padding: 12 },
  field: { gap: 6 },
  label: { fontSize: 13, fontFamily: font.medium },
  providers: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  provider: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 7 },
  providerText: { fontSize: 13, fontFamily: font.medium },
  error: { fontSize: 13, fontFamily: font.regular },
});

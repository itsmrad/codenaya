import { useAuth } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";
import { ChevronRight, ExternalLink, Server } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button, Field } from "@/components/form";
import { Sheet, SheetRow } from "@/components/sheet";
import { postApi } from "@/lib/http";
import { getProvider, listProviders } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

/** The connect route's id for a custom MCP server (provider-catalog.tsx). */
const CUSTOM = "custom";

/**
 * The web's Add a connection flow: pick a catalog provider (or a custom MCP
 * server), then authorize with OAuth in the browser or paste an API key. The
 * new connection shows up through the live connections query.
 */
export function AddConnectionSheet({
  visible,
  onClose,
  projectId,
}: {
  visible: boolean;
  onClose: () => void;
  /** Links the new connection to this project too. */
  projectId?: string;
}) {
  const c = useColors();
  const { getToken } = useAuth();
  const [providerId, setProviderId] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [busy, setBusy] = useState<"oauth" | "key">();
  const [error, setError] = useState<string>();
  const provider = providerId ? getProvider(providerId) : undefined;
  const custom = providerId === CUSTOM;
  const name = custom ? "Custom MCP server" : (provider?.displayName ?? "");

  const close = () => {
    setProviderId(undefined);
    setApiKey("");
    setLabel("");
    setServerUrl("");
    setError(undefined);
    onClose();
  };

  const request = async (kind: "oauth" | "key", path: string, body: object) => {
    setBusy(kind);
    setError(undefined);
    try {
      const response = await postApi<{ authorizationUrl?: string }>(path, body, getToken);
      if (!response.ok) setError(response.data.error ?? "Unable to connect");
      return response;
    } catch {
      setError("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setBusy(undefined);
    }
  };

  const startOAuth = async () => {
    const response = await request("oauth", "/api/integrations/oauth/start", { providerId, projectId });
    const url = response?.ok && response.data.authorizationUrl;
    if (!url) return;
    close();
    // The provider returns to the website's callback, which stores the tokens.
    await WebBrowser.openBrowserAsync(url);
  };

  const connectKey = async () => {
    const response = await request("key", "/api/integrations/connect", {
      providerId,
      apiKey: apiKey.trim(),
      label: label.trim() || undefined,
      projectId,
      serverUrl: custom ? serverUrl.trim() : undefined,
    });
    if (response?.ok) close();
  };

  const usesKey = custom || provider?.authModes.includes("api_key");
  return (
    <Sheet
      visible={visible}
      title={providerId ? `Add ${name}` : "Add a connection"}
      description={
        providerId
          ? undefined
          : "A connection gives your agent real tools using your own credentials, like querying a database or opening a pull request."
      }
      onClose={close}
    >
      {!providerId ? (
        <>
          {listProviders().map((item) => (
            <SheetRow
              key={item.id}
              label={item.displayName}
              detail={item.authModes.map((mode) => (mode === "oauth" ? "OAuth" : "API key")).join(" or ")}
              trailing={<ChevronRight size={16} color={c.mutedForeground} />}
              onPress={() => setProviderId(item.id)}
            />
          ))}
          <SheetRow
            icon={<Server size={16} color={c.mutedForeground} />}
            label="Custom MCP server"
            detail="Any MCP server URL with an API key"
            trailing={<ChevronRight size={16} color={c.mutedForeground} />}
            onPress={() => setProviderId(CUSTOM)}
          />
        </>
      ) : (
        <View style={styles.form}>
          {provider?.authModes.includes("oauth") && (
            <>
              <Button
                label={`Connect with ${name}`}
                icon={<ExternalLink size={15} color={c.primaryForeground} />}
                busy={busy === "oauth"}
                onPress={startOAuth}
              />
              {usesKey && <Text style={[styles.or, { color: c.mutedForeground }]}>or use an API key</Text>}
            </>
          )}
          {usesKey && (
            <>
              {custom && (
                <Field
                  label="Server URL"
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="https://mcp.example.com/mcp"
                  keyboardType="url"
                />
              )}
              <Field
                label="API key"
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="Paste your API key"
                secureTextEntry
                hint={provider?.apiKey?.hint}
              />
              <Field
                label="Label (optional)"
                value={label}
                onChangeText={setLabel}
                placeholder={name}
                autoCapitalize="sentences"
              />
              <Button
                label="Connect"
                variant={provider?.authModes.includes("oauth") ? "outline" : "primary"}
                busy={busy === "key"}
                disabled={!apiKey.trim() || (custom && !serverUrl.trim())}
                onPress={connectKey}
              />
            </>
          )}
          {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
          <Button label="Back" variant="outline" onPress={() => setProviderId(undefined)} />
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, padding: 12 },
  or: { textAlign: "center", fontSize: 12, fontFamily: font.regular },
  error: { fontSize: 13, fontFamily: font.regular },
});

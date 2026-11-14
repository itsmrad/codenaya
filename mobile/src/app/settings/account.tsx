import { useAuth, useUser } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GitHubIcon } from "@/components/github-icon";
import { GoogleIcon } from "@/components/google-icon";
import { LabelStrip, TileRow, monoLabel } from "@/components/grid";
import { ArrowUpRight, ExternalLink, LogOut, Pencil } from "@/components/icons";
import { NameDialog } from "@/components/name-dialog";
import { UserAvatar, useDisplayName } from "@/components/user-avatar";
import { webUrl } from "@/lib/http";
import { font, useColors } from "@/lib/theme";

const MANAGE_URL = webUrl("/settings/account");

/**
 * The web's Account page (Clerk's UserProfile): the profile, the connected
 * Google and GitHub accounts, and sign out. Connecting an account or changing
 * email and security happens on the website, since Clerk's OAuth linking
 * needs a dev build.
 */
export default function AccountSettings() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const { user } = useUser();
  const name = useDisplayName();
  const [renaming, setRenaming] = useState(false);
  if (!user) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;

  const connected = (provider: string) => user.externalAccounts.find((account) => account.provider === provider);
  const providers = [
    { id: "github", label: "GitHub", icon: <GitHubIcon size={20} color={c.foreground} /> },
    { id: "google", label: "Google", icon: <GoogleIcon size={18} /> },
  ];
  const openWebsite = () => WebBrowser.openBrowserAsync(MANAGE_URL);

  const rename = async (fullName: string) => {
    const [firstName, ...rest] = fullName.split(/\s+/);
    await user.update({ firstName, lastName: rest.join(" ") });
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={[styles.profile, { backgroundColor: c.card, borderColor: c.border }]}>
        <UserAvatar size={72} />
        <Pressable
          onPress={() => setRenaming(true)}
          hitSlop={8}
          accessibilityLabel="Edit name"
          style={({ pressed }) => [styles.nameRow, pressed && styles.dim]}
        >
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          <Pencil size={15} color={c.mutedForeground} />
        </Pressable>
        <Text style={[styles.email, { color: c.mutedForeground }]} numberOfLines={1}>
          {user.primaryEmailAddress?.emailAddress}
        </Text>
      </View>

      <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip label="Connected accounts" />
        {providers.map(({ id, label, icon }) => {
          const account = connected(id);
          return (
            <View key={id} style={[styles.account, { borderColor: c.border }]}>
              <View style={styles.mark}>{icon}</View>
              <View style={styles.flex}>
                <Text style={[styles.label, { color: c.foreground }]}>{label}</Text>
                {account && (account.emailAddress || account.username) && (
                  <Text style={[styles.detail, { color: c.mutedForeground }]} numberOfLines={1}>
                    {account.emailAddress || account.username}
                  </Text>
                )}
              </View>
              {account ? (
                <Text style={[monoLabel, styles.tag, { color: c.success, borderColor: `${c.success}55` }]}>Connected</Text>
              ) : (
                <Pressable
                  onPress={openWebsite}
                  accessibilityLabel={`Connect ${label} on the website`}
                  style={({ pressed }) => [styles.connect, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
                >
                  <Text style={[monoLabel, { color: c.foreground }]}>Connect</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>

      <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
        <TileRow
          icon={ExternalLink}
          label="Manage account on the website"
          trailing={<ArrowUpRight size={16} color={c.mutedForeground} />}
          onPress={openWebsite}
        />
        <TileRow icon={LogOut} label="Sign out" destructive onPress={() => signOut()} />
      </View>

      <NameDialog
        visible={renaming}
        title="Edit name"
        initialName={user.fullName ?? ""}
        placeholder="Your name"
        onClose={() => setRenaming(false)}
        onSave={rename}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dim: { opacity: 0.6 },
  profile: { alignItems: "center", paddingTop: 28, paddingBottom: 26, paddingHorizontal: 16, borderBottomWidth: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16, maxWidth: "100%" },
  name: { flexShrink: 1, fontSize: 20, fontFamily: font.semibold, letterSpacing: -0.3 },
  email: { marginTop: 4, fontSize: 14, fontFamily: font.regular },
  section: { marginTop: 20, borderTopWidth: 1 },
  account: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  mark: { width: 22, alignItems: "center" },
  label: { fontSize: 15, fontFamily: font.medium },
  detail: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
  connect: { height: 30, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 6 },
});

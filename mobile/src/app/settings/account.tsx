import { useAuth, useUser } from "@clerk/expo";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/form";
import { GoogleIcon } from "@/components/google-icon";
import { CheckCircle2, ExternalLink, GitBranch, LogOut, Pencil } from "@/components/icons";
import { NameDialog } from "@/components/name-dialog";
import { SheetRow } from "@/components/sheet";
import { webUrl } from "@/lib/http";
import { getInitials } from "@/lib/project-cover";
import { font, radius, useColors } from "@/lib/theme";

const MANAGE_URL = webUrl("/settings/account");

/**
 * The web's Account page (Clerk's UserProfile): the profile, the connected
 * Google and GitHub accounts, and sign out. Connecting an account or changing
 * email and security happens on the website, since Clerk's OAuth linking
 * needs a dev build.
 */
export default function AccountSettings() {
  const c = useColors();
  const { signOut } = useAuth();
  const { user } = useUser();
  const [renaming, setRenaming] = useState(false);
  if (!user) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;

  const name = user.fullName || user.username || "Your account";
  const connected = (provider: string) => user.externalAccounts.find((account) => account.provider === provider);
  const providers = [
    { id: "google", label: "Google", icon: <GoogleIcon size={18} /> },
    { id: "github", label: "GitHub", icon: <GitBranch size={18} color={c.foreground} /> },
  ];

  const rename = async (fullName: string) => {
    const [firstName, ...rest] = fullName.split(/\s+/);
    await user.update({ firstName, lastName: rest.join(" ") });
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.card, styles.profile, { backgroundColor: c.card, borderColor: c.border }]}>
        {user.hasImage ? (
          <Image source={user.imageUrl} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, { backgroundColor: c.muted }]}>
            <Text style={[styles.initials, { color: c.foreground }]}>{getInitials(name)}</Text>
          </View>
        )}
        <View style={styles.flex}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.muted, { color: c.mutedForeground }]} numberOfLines={1}>
            {user.primaryEmailAddress?.emailAddress}
          </Text>
        </View>
        <Pressable onPress={() => setRenaming(true)} hitSlop={10} accessibilityLabel="Edit name">
          <Pencil size={16} color={c.mutedForeground} />
        </Pressable>
      </View>

      <Text style={[styles.section, { color: c.mutedForeground }]}>Connected accounts</Text>
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        {providers.map(({ id, label, icon }) => {
          const account = connected(id);
          return (
            <SheetRow
              key={id}
              icon={icon}
              label={label}
              detail={account ? account.emailAddress || account.username || "Connected" : "Not connected"}
              trailing={
                account ? (
                  <CheckCircle2 size={16} color={c.mutedForeground} />
                ) : (
                  <Text style={[styles.link, { color: c.brandText }]}>Connect</Text>
                )
              }
              onPress={account ? undefined : () => WebBrowser.openBrowserAsync(MANAGE_URL)}
            />
          );
        })}
      </View>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>
        GitHub lets Codenaya import private repositories and export projects.
      </Text>

      <View style={styles.actions}>
        <Button
          label="Manage account on the website"
          variant="outline"
          icon={<ExternalLink size={15} color={c.foreground} />}
          onPress={() => WebBrowser.openBrowserAsync(MANAGE_URL)}
        />
        <Button
          label="Sign out"
          variant="destructive"
          icon={<LogOut size={15} color={c.destructive} />}
          onPress={() => signOut()}
        />
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
  page: { padding: 16, gap: 8 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 4 },
  profile: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  initials: { fontSize: 16, fontFamily: font.semibold },
  name: { fontSize: 16, fontFamily: font.semibold },
  muted: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  section: { fontSize: 12, fontFamily: font.medium, marginTop: 16, marginLeft: 4 },
  link: { fontSize: 13, fontFamily: font.medium },
  hint: { fontSize: 12, fontFamily: font.regular, marginLeft: 4 },
  actions: { gap: 10, marginTop: 20 },
});

import { useUser } from "@clerk/expo";
import { useQuery } from "convex/react";
import Constants from "expo-constants";
import { type Href, useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LabelStrip, TileRow, monoLabel } from "@/components/grid";
import { ChevronRight, KeyRound, type LucideIcon, Plug, Sparkles, SunMoon, User } from "@/components/icons";
import { UserAvatar, useDisplayName } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { font, useColors } from "@/lib/theme";

type Item = { href: Href; label: string; detail: string; icon: LucideIcon };

// The web's SETTINGS_NAV (settings/nav.ts), in the same order, grouped.
const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Account",
    items: [{ href: "/settings/account", label: "Account", detail: "Profile, connected accounts, sign out", icon: User }],
  },
  {
    title: "Agent",
    items: [
      { href: "/settings/ai-providers", label: "AI providers", detail: "Your own API keys and default model", icon: KeyRound },
      { href: "/settings/skills", label: "Skills", detail: "Reusable instructions for your agent", icon: Sparkles },
      { href: "/settings/integrations", label: "Integrations", detail: "Services your agent can use", icon: Plug },
    ],
  },
  {
    title: "App",
    items: [{ href: "/settings/appearance", label: "Appearance", detail: "Light, dark or system", icon: SunMoon }],
  },
];

export default function Settings() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const name = useDisplayName();
  // No credit account until the first metered run: that's the free plan.
  const credits = useQuery(api.credits.getMine);
  const plan = credits === undefined ? undefined : (credits?.plan ?? "free");

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={[styles.profile, { backgroundColor: c.card, borderColor: c.border }]}>
        <UserAvatar />
        <View style={styles.flex}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.detail, { color: c.mutedForeground }]} numberOfLines={1}>
            {user?.primaryEmailAddress?.emailAddress}
          </Text>
        </View>
        {plan && (
          <Text style={[monoLabel, styles.tag, { color: c.mutedForeground, borderColor: c.border }]}>{plan}</Text>
        )}
      </View>

      {SECTIONS.map((section) => (
        <View key={section.title} style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
          <LabelStrip label={section.title} />
          {section.items.map(({ href, label, detail, icon }) => (
            <TileRow
              key={label}
              icon={icon}
              label={label}
              detail={detail}
              trailing={<ChevronRight size={16} color={c.mutedForeground} />}
              onPress={() => router.push(href)}
            />
          ))}
        </View>
      ))}

      <Text style={[monoLabel, styles.version, { color: c.mutedForeground }]}>
        Codenaya for mobile · v{Constants.expoConfig?.version}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  profile: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderBottomWidth: 1 },
  name: { fontSize: 17, fontFamily: font.semibold, letterSpacing: -0.2 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
  section: { marginTop: 20, borderTopWidth: 1 },
  detail: { fontSize: 13, fontFamily: font.regular, marginTop: 2 },
  version: { textAlign: "center", marginTop: 24 },
});

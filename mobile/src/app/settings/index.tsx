import { type Href, useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";

import { ChevronRight, KeyRound, type LucideIcon, Palette, Plug, Sparkles, User } from "@/components/icons";
import { SheetRow } from "@/components/sheet";
import { useColors } from "@/lib/theme";

// The web's SETTINGS_NAV (settings/nav.ts), in the same order.
const SETTINGS: { href: Href; label: string; detail: string; icon: LucideIcon }[] = [
  { href: "/settings/account", label: "Account", detail: "Profile, connected accounts, sign out", icon: User },
  { href: "/settings/ai-providers", label: "AI providers", detail: "Your own API keys and default model", icon: KeyRound },
  { href: "/settings/skills", label: "Skills", detail: "Reusable instructions for your agent", icon: Sparkles },
  { href: "/settings/integrations", label: "Integrations", detail: "Services your agent can use", icon: Plug },
  { href: "/settings/appearance", label: "Appearance", detail: "Light, dark or system", icon: Palette },
];

export default function Settings() {
  const c = useColors();
  const router = useRouter();
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {SETTINGS.map(({ href, label, detail, icon: Icon }) => (
        <SheetRow
          key={label}
          icon={<Icon size={18} color={c.mutedForeground} />}
          label={label}
          detail={detail}
          trailing={<ChevronRight size={16} color={c.mutedForeground} />}
          onPress={() => router.push(href)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { padding: 8 },
});

import type { FunctionReturnType } from "convex/server";
import { StyleSheet, View } from "react-native";

import { GitHubIcon } from "@/components/github-icon";
import { BookOpen, Bug, Cloud, CreditCard, Database, type LucideIcon, Plug, SquareKanban } from "@/components/icons";
import type { api } from "@/lib/api";
import { useColors } from "@/lib/theme";

export type Connection = FunctionReturnType<typeof api.integrations.listUserConnections>[number];

// Each provider's mark and tint; the web lists them by name only.
const PROVIDER_MARKS: Record<string, { icon: LucideIcon | typeof GitHubIcon; tint?: string }> = {
  supabase: { icon: Database, tint: "#10b981" },
  neon: { icon: Database, tint: "#14b8a6" },
  prisma: { icon: Database, tint: "#6366f1" },
  stripe: { icon: CreditCard, tint: "#6366f1" },
  github: { icon: GitHubIcon },
  sentry: { icon: Bug, tint: "#8b5cf6" },
  cloudflare: { icon: Cloud, tint: "#f59e0b" },
  linear: { icon: SquareKanban, tint: "#6366f1" },
  context7: { icon: BookOpen, tint: "#10b981" },
};

/** A provider's mark in a tinted square. */
export function ProviderTile({ providerId }: { providerId: string }) {
  const c = useColors();
  const { icon: Icon, tint = c.foreground } = PROVIDER_MARKS[providerId] ?? { icon: Plug };
  return (
    <View style={[styles.tile, { backgroundColor: `${tint}1f` }]}>
      <Icon size={18} color={tint} />
    </View>
  );
}

// Tailwind's emerald-500 and amber-500, the web's status pill tints.
export const STATUS = {
  active: { label: "Active", tint: "#10b981" },
  needs_reauth: { label: "Needs reauth", tint: "#f59e0b" },
  revoked: { label: "Revoked", tint: undefined },
  error: { label: "Error", tint: undefined },
};

const styles = StyleSheet.create({
  tile: { width: 36, height: 36, borderRadius: 6, alignItems: "center", justifyContent: "center" },
});

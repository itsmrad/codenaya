import {
  type LucideIcon,
  PaletteIcon,
  PlugIcon,
  UserIcon,
} from "lucide-react";

export const SETTINGS_URL = "/settings";
export const ACCOUNT_SETTINGS_URL = "/settings/account";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Every settings tab, in display order. Drives both the desktop sidebar and
 * the mobile tabs, so a new tab (AI providers, Skills, Billing) is one entry
 * here plus its page under `src/app/settings/`.
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: ACCOUNT_SETTINGS_URL, label: "Account", icon: UserIcon },
  { href: "/settings/integrations", label: "Integrations", icon: PlugIcon },
  { href: "/settings/appearance", label: "Appearance", icon: PaletteIcon },
];

"use client";

import { SectionNav } from "@/components/section-nav";

import { SETTINGS_NAV } from "../nav";

// Client side, since the nav items carry icon components.
export const SettingsNav = () => <SectionNav label="Settings" items={SETTINGS_NAV} />;

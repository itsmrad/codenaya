import { BoxesIcon, HistoryIcon } from "lucide-react";

import type { SectionNavItem } from "@/components/section-nav";

export const ADMIN_URL = "/admin";
export const ADMIN_AUDIT_URL = "/admin/audit";

export const ADMIN_NAV: SectionNavItem[] = [
  { href: ADMIN_URL, label: "Models", icon: BoxesIcon },
  { href: ADMIN_AUDIT_URL, label: "Audit log", icon: HistoryIcon },
];

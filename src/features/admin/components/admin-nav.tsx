"use client";

import { SectionNav } from "@/components/section-nav";

import { ADMIN_NAV } from "../nav";

// Client side, since the nav items carry icon components.
export const AdminNav = () => <SectionNav label="Admin" items={ADMIN_NAV} />;

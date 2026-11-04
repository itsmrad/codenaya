import type { Metadata } from "next";

import { AuditLogCard } from "@/features/admin/components/audit-log-card";

export const metadata: Metadata = { title: "Audit log · Admin", robots: { index: false } };

// Blocks on the session in the admin layout; see `instant` there.
export const instant = false;

const AdminAuditPage = () => (
  <>
    <header className="space-y-1">
      <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
      <p className="text-sm text-muted-foreground">Who changed what, written with every save.</p>
    </header>
    <AuditLogCard />
  </>
);

export default AdminAuditPage;

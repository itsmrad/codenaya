import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { AdminNav } from "@/features/admin/components/admin-nav";
import { adminOrNull } from "@/features/admin/server/require-admin";

// Blocks on the session like the settings pages; see `instant` there.
export const instant = false;

const AdminContent = async ({ children }: { children: React.ReactNode }) => {
  // Signed out, not the admin and unverified all get the same 404, with no
  // sign-in redirect, so /admin looks like any missing page. Every admin
  // Convex function and route checks again on its own.
  if (!(await adminOrNull())) notFound();

  return (
    <ConvexAuthBoundary>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row lg:gap-10 lg:py-10">
        <AdminNav />
        <main className="min-w-0 flex-1 space-y-6">{children}</main>
      </div>
    </ConvexAuthBoundary>
  );
};

const AdminLayout = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen flex-col bg-background">
    <AppNavbar />
    <Suspense fallback={<AuthLoadingView />}>
      <AdminContent>{children}</AdminContent>
    </Suspense>
  </div>
);

export default AdminLayout;

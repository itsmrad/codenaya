import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { SettingsNav } from "@/features/settings/components/settings-nav";

const SettingsContent = async ({ children }: { children: React.ReactNode }) => {
  // Signed-out visitors are redirected to /sign-in and returned here after.
  await auth.protect();

  return (
    <ConvexAuthBoundary>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row lg:gap-10 lg:py-10">
        <SettingsNav />
        <main className="min-w-0 flex-1 space-y-6">{children}</main>
      </div>
    </ConvexAuthBoundary>
  );
};

const SettingsLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <Suspense fallback={<AuthLoadingView />}>
        <SettingsContent>{children}</SettingsContent>
      </Suspense>
    </div>
  );
};

export default SettingsLayout;

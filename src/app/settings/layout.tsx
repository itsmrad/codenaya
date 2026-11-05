import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { LabelBar } from "@/components/landing/section-header";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { SettingsNav } from "@/features/settings/components/settings-nav";

// Every settings page waits on the session (`auth.protect()` below), so
// navigations into them block by design. Opting out here and on each page
// keeps the dev-only instant-navigation validator from logging an error on
// every visit (it validates each page segment separately).
export const instant = false;

const SettingsContent = async ({ children }: { children: React.ReactNode }) => {
  // Signed-out visitors are redirected to /sign-in and returned here after.
  await auth.protect();

  return (
    <ConvexAuthBoundary>
      {/* The dashboard's grid: one framed column, the nav in a cell of its own. */}
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-border">
        <LabelBar label="Settings" />
        <div className="flex flex-1 flex-col lg:flex-row">
          <aside className="border-border px-4 pt-6 sm:px-6 lg:w-60 lg:shrink-0 lg:border-r lg:pt-10">
            <div className="lg:sticky lg:top-24">
              <SettingsNav />
            </div>
          </aside>
          <main className="min-w-0 flex-1 space-y-6 px-4 py-8 sm:px-6 md:px-8 lg:py-10">{children}</main>
        </div>
      </div>
    </ConvexAuthBoundary>
  );
};

const SettingsLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar framed />
      <Suspense fallback={<AuthLoadingView />}>
        <SettingsContent>{children}</SettingsContent>
      </Suspense>
    </div>
  );
};

export default SettingsLayout;

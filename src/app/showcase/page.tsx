import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { ShowcaseFeed } from "@/features/showcase/components/showcase-feed";

const ShowcaseContent = async () => {
  // Signed-out visitors are redirected to /sign-in and returned here after.
  await auth.protect();

  return (
    <ConvexAuthBoundary>
      <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Community showcase</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Apps people built with Codenaya. Open one to preview it or import a copy into your workspace.
        </p>
        <ShowcaseFeed />
      </main>
    </ConvexAuthBoundary>
  );
};

const ShowcasePage = () => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <Suspense fallback={<AuthLoadingView />}>
        <ShowcaseContent />
      </Suspense>
    </div>
  );
};

export default ShowcasePage;

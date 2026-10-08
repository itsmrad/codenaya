import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { LandingPage } from "@/components/landing/landing-page";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { ProjectsView } from "@/features/projects/components/projects-view";

const HomeContent = async () => {
  const { userId } = await auth();

  if (!userId) {
    return <LandingPage />;
  }

  return (
    <ConvexAuthBoundary>
      <div className="h-screen flex flex-col overflow-hidden">
        <AppNavbar />
        <div className="flex-1 min-h-0 overflow-hidden">
          <ProjectsView />
        </div>
      </div>
    </ConvexAuthBoundary>
  );
};

const Home = () => {
  return (
    <Suspense fallback={<AuthLoadingView />}>
      <HomeContent />
    </Suspense>
  );
};

export default Home;

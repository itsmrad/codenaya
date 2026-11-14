import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { LandingPage } from "@/components/landing/landing-page";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { ProjectsView } from "@/features/projects/components/projects-view";
import { parseGithubRepo } from "@/features/projects/utils/github-repo";

type HomeProps = {
  searchParams: Promise<{ import?: string | string[] }>;
};

const HomeContent = async ({ searchParams }: HomeProps) => {
  const { userId } = await auth();

  if (!userId) {
    return <LandingPage />;
  }

  // Set by /import for an "Open in Codenaya" link (#231).
  const { import: repo } = await searchParams;

  return (
    <ConvexAuthBoundary>
      {/* The page itself scrolls, like the public pages, under a sticky navbar. */}
      <div className="flex min-h-screen flex-col">
        <AppNavbar framed />
        <ProjectsView linkedRepo={typeof repo === "string" ? parseGithubRepo(repo) : null} />
      </div>
    </ConvexAuthBoundary>
  );
};

const Home = (props: HomeProps) => {
  return (
    <Suspense fallback={<AuthLoadingView />}>
      <HomeContent {...props} />
    </Suspense>
  );
};

export default Home;

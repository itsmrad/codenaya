import type { Metadata } from "next";

import { AppNavbar } from "@/components/app-navbar";
import { LandingFooter } from "@/components/landing/footer";
import { ShowcaseFeed } from "@/features/showcase/components/showcase-feed";

export const metadata: Metadata = {
  title: "Community showcase — Codenaya",
  description: "Apps people built with Codenaya. Open one to see it, share it, or remix it.",
};

// Public: the showcase queries need no auth, so signed-out visitors can browse.
const ShowcasePage = () => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Community showcase</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Apps people built with Codenaya. Open one to preview it or remix a copy into your workspace.
        </p>
        <ShowcaseFeed />
      </main>
      <LandingFooter />
    </div>
  );
};

export default ShowcasePage;

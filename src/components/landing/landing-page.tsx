"use client";

import { SmoothScrollProvider } from "@/components/smooth-scroll-provider";
import { LandingNavbar } from "./navbar";
import { LandingHero } from "./hero";
import { LandingDemo } from "./demo-video";
import { LandingCommunityStrip } from "./community-strip";
import { LandingFeatures } from "./features";
import { LandingHowItWorks } from "./how-it-works";
import { LandingCTA } from "./cta-section";
import { LandingFooter } from "./footer";

export const LandingPage = () => {
  return (
    <SmoothScrollProvider>
      <div className="relative min-h-screen bg-background overflow-x-hidden">
        <LandingNavbar />
        <main>
          <LandingHero />
          <LandingDemo />
          <LandingCommunityStrip />
          <LandingFeatures />
          <LandingHowItWorks />
          <LandingCTA />
        </main>
        <LandingFooter />
      </div>
    </SmoothScrollProvider>
  );
};

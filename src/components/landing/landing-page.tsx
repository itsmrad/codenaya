"use client";

import { LandingHero } from "./hero";
import { LandingModelMarquee } from "./model-marquee";
import { LandingHowItWorks } from "./how-it-works";
import { LandingFeatures } from "./features";
import { LandingProviders } from "./providers";
import { LandingCommunityStrip } from "./community-strip";
import { LandingTrust } from "./trust";
import { LandingFaq } from "./faq";
import { LandingCTA } from "./cta-section";
import { PublicShell } from "./public-shell";

export const LandingPage = () => {
  return (
    <PublicShell>
      <LandingHero />
      <LandingModelMarquee />
      <LandingHowItWorks />
      <LandingFeatures />
      <LandingProviders />
      <LandingCommunityStrip />
      <LandingTrust />
      <LandingFaq />
      <LandingCTA />
    </PublicShell>
  );
};

import type { Metadata } from "next";
import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";

import { AppNavbar } from "@/components/app-navbar";
import { MarketingNavbar } from "@/components/marketing-navbar";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { PromoClaimPanel } from "@/features/promotions/components/promo-claim-panel";
import { PromoSignInStep } from "@/features/promotions/components/promo-sign-in-step";
import { PromoView } from "@/features/promotions/components/promo-view";

export const metadata: Metadata = {
  title: "Free Claude Opus 5.5 — Codenaya",
  description:
    "20 free Claude Opus 5.5 runs and unlimited Sonnet 5.5 for GitHub accounts older than a year.",
};

/**
 * The GitHub promotion (ADR 0009). Signed-out visitors sign in, with GitHub
 * if they like, and come back here; signed-in users connect GitHub and claim.
 */
const PromoContent = async () => {
  const { userId } = await auth();

  if (userId) {
    return (
      <ConvexAuthBoundary>
        <div className="flex h-screen flex-col overflow-hidden">
          <AppNavbar />
          <PromoView>
            <PromoClaimPanel />
          </PromoView>
        </div>
      </ConvexAuthBoundary>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNavbar />
      <PromoView>
        <PromoSignInStep />
      </PromoView>
    </div>
  );
};

const PromoPage = () => (
  <Suspense fallback={<AuthLoadingView />}>
    <PromoContent />
  </Suspense>
);

export default PromoPage;

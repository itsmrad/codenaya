"use client";

import { useUser } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";

interface OnboardingGuardProps {
  children: React.ReactNode;
}

export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const { user, isLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const pathname = usePathname();

  const isOnboardingRoute = pathname.startsWith("/onboarding");
  const isSSOCallback = pathname === "/onboarding/sso-callback";
  const isProjectRoute = pathname.startsWith("/projects");
  const hasCompletedOnboarding = !!user?.publicMetadata?.hasCompletedOnboarding;

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    // Never redirect if already on a project route, onboarding route, or during SSO callback
    if (isProjectRoute || isSSOCallback || isOnboardingRoute) return;

    // If signed-in user has NOT completed onboarding and visits the root landing page, route to onboarding
    if (!hasCompletedOnboarding && pathname === "/") {
      router.replace("/onboarding");
    }
  }, [isLoaded, isSignedIn, hasCompletedOnboarding, pathname, isProjectRoute, isSSOCallback, router]);

  // Loading state: Only show if auth state has not yet loaded
  if (!isLoaded) {
    return <AuthLoadingView />;
  }

  return <>{children}</>;
}

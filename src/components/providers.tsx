"use client";

import { Suspense, useCallback, useMemo } from "react";
import { 
  Authenticated, 
  Unauthenticated,
  ConvexReactClient,
  AuthLoading, 
} from "convex/react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { usePathname } from "next/navigation";

import { LandingPage } from "@/components/landing/landing-page";
import { OnboardingGuard } from "@/components/onboarding/onboarding-guard";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";

import { ThemeProvider } from "./theme-provider";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Enhanced useAuth hook for Convex that attempts Clerk's "convex" JWT template
 * and seamlessly falls back to standard session token if the template is not present.
 */
function useAuthForConvex() {
  const clerkAuth = useAuth();

  const customGetToken = useCallback(
    async (options?: { template?: string; skipCache?: boolean }) => {
      // 1. Try template "convex" if requested
      if (options?.template === "convex") {
        try {
          const token = await clerkAuth.getToken({
            template: "convex",
            skipCache: options?.skipCache,
          });
          if (token) return token;
        } catch {
          // Template "convex" not configured in Clerk dashboard — fall through
        }
      }

      // 2. Fall back to standard session token
      try {
        const token = await clerkAuth.getToken({
          skipCache: options?.skipCache,
        });
        if (token) return token;
      } catch {
        return null;
      }
      return null;
    },
    [clerkAuth]
  );

  return useMemo(
    () => ({
      ...clerkAuth,
      getToken: customGetToken,
    }),
    [clerkAuth, customGetToken]
  );
}

function AuthContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isOnboarding = pathname.startsWith("/onboarding");
  const isProjectRoute = pathname.startsWith("/projects");

  // CRITICAL: Project routes must ALWAYS render the IDE workspace.
  // Never replace a project route with the LandingPage.
  if (isProjectRoute) {
    return <>{children}</>;
  }

  // Onboarding wizard routes must always render their wizard flow.
  if (isOnboarding) {
    return <>{children}</>;
  }

  // Root or other general routes:
  return (
    <>
      <Authenticated>
        <OnboardingGuard>
          {children}
        </OnboardingGuard>
      </Authenticated>
      <Unauthenticated>
        <LandingPage />
      </Unauthenticated>
      <AuthLoading>
        <AuthLoadingView />
      </AuthLoading>
    </>
  );
}

export const Providers = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuthForConvex}>
         <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <Suspense fallback={<AuthLoadingView />}>
            <AuthContent>{children}</AuthContent>
          </Suspense>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
};


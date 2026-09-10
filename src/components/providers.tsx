"use client";

import {
  Authenticated,
  Unauthenticated,
  ConvexProvider,
  ConvexReactClient,
  AuthLoading,
} from "convex/react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { LandingPage } from "@/components/landing/landing-page";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";

import { ThemeProvider } from "./theme-provider";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Local-only escape hatch, paired with `CODENAYA_DEV_AUTH_BYPASS` on the Convex
 * deployment. Without a Clerk instance `<Authenticated>` never matches, so the
 * app renders the landing page forever and the IDE is unreachable. This skips
 * both the Clerk token exchange and the gate.
 */
const DEV_AUTH_BYPASS =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "1";

export const Providers = ({ children }: { children: React.ReactNode }) => {
  if (DEV_AUTH_BYPASS) {
    return (
      <ClerkProvider>
        <ConvexProvider client={convex}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </ConvexProvider>
      </ClerkProvider>
    );
  }

  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
         <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <Authenticated>
            {children}
          </Authenticated>
          <Unauthenticated>
            <LandingPage />
          </Unauthenticated>
          <AuthLoading>
            <AuthLoadingView />
          </AuthLoading>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
};

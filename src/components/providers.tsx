"use client";

import { useEffect, useRef } from "react";
import { MotionConfig } from "motion/react";

import { ConvexReactClient } from "convex/react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import {
  AFTER_AUTH_URL,
  SIGN_IN_URL,
  SIGN_UP_URL,
} from "@/features/auth/constants";
import { useEnsureCurrentUser } from "@/features/auth/hooks/use-ensure-current-user";
import { clearAllProjectSessions } from "@/features/editor/editor-session";

import { SpotlightTracker } from "./spotlight";
import { ThemeProvider } from "./theme-provider";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// The shadcn theme reads the app's CSS variables, so Clerk follows light/dark.
// Primary actions use the brand color like every other CTA in the app.
const clerkAppearance = {
  theme: shadcn,
  variables: {
    colorPrimary: "var(--brand)",
    colorPrimaryForeground: "var(--brand-foreground)",
    fontFamily: "var(--font-inter)",
  },
  // Clerk also draws links, text buttons and the active nav item in
  // colorPrimary, which is too light for text on light surfaces (#216).
  elements: {
    footerActionLink: { color: "var(--brand-text)" },
    navbarButton: { '&[data-active="true"]': { color: "var(--brand-text)" } },
    profileSectionPrimaryButton: { color: "var(--brand-text)" },
    menuButton__connectedAccounts: { color: "var(--brand-text)" },
  },
};

// Clerk's own subtitles ("Welcome back! Please sign in to continue") replaced
// with plain, specific lines.
const clerkLocalization = {
  signIn: { start: { subtitle: "Use GitHub, Google or your email" } },
  signUp: {
    start: {
      subtitle: "Start free with 300 credits a month",
      subtitleCombined: "Start free with 300 credits a month",
    },
  },
};

const EnsureCurrentUser = () => {
  useEnsureCurrentUser();
  return null;
};

// Retained editor drafts belong to the signed-in user; drop them on sign-out or a user switch (#618).
const ClearDraftsOnSignOut = () => {
  const { userId } = useAuth();
  const previous = useRef(userId);
  useEffect(() => {
    if (userId === undefined) return;
    if (previous.current && previous.current !== userId) clearAllProjectSessions();
    previous.current = userId;
  }, [userId]);
  return null;
};

export const Providers = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      localization={clerkLocalization}
      signInUrl={SIGN_IN_URL}
      signUpUrl={SIGN_UP_URL}
      signInFallbackRedirectUrl={AFTER_AUTH_URL}
      signUpFallbackRedirectUrl={AFTER_AUTH_URL}
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <EnsureCurrentUser />
        <ClearDraftsOnSignOut />
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <SpotlightTracker />
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
};

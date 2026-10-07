"use client";

import { ConvexReactClient } from "convex/react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import {
  AFTER_AUTH_URL,
  SIGN_IN_URL,
  SIGN_UP_URL,
} from "@/features/auth/constants";

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
};

export const Providers = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      signInUrl={SIGN_IN_URL}
      signUpUrl={SIGN_UP_URL}
      signInFallbackRedirectUrl={AFTER_AUTH_URL}
      signUpFallbackRedirectUrl={AFTER_AUTH_URL}
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
};

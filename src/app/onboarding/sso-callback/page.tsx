"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

// Clerk's authenticateWithRedirect() (used for the GitHub button in
// auth-step.tsx) and user.createExternalAccount() (used for the GitHub link
// button in github-step.tsx) need a page to land on after the OAuth round-trip
// completes. This hands control back to Clerk to finish the job and return to /onboarding.
export default function SSOCallbackPage() {
  return (
    <div className="dark min-h-screen bg-card flex items-center justify-center">
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl="/onboarding"
        signUpFallbackRedirectUrl="/onboarding"
        signInForceRedirectUrl="/onboarding"
        signUpForceRedirectUrl="/onboarding"
        continueSignUpUrl="/onboarding"
      />
    </div>
  );
}

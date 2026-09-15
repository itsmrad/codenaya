"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

// Clerk's authenticateWithRedirect() (used for the GitHub button in
// auth-step.tsx) needs a page to land on after the OAuth round-trip
// completes. This just hands control back to Clerk to finish the job.
export default function SSOCallbackPage() {
  return <AuthenticateWithRedirectCallback />;
}

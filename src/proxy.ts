import { clerkMiddleware } from '@clerk/nextjs/server';

import { SIGN_IN_URL, SIGN_UP_URL } from '@/features/auth/constants';

// Routes are protected where they read data (`auth.protect()` in pages,
// `requireUserId()` in route handlers), not here. The URLs tell
// `auth.protect()` where to send signed-out visitors.
export default clerkMiddleware({
  signInUrl: SIGN_IN_URL,
  signUpUrl: SIGN_UP_URL,
});

export const config = {
  matcher: [
    // Skip Next.js internals, all static files (unless found in search params),
    // and Workflow SDK internal paths
    '/((?!_next|\\.well-known/workflow/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { ownerPreviewProject } from '@/features/projects/server/owner-preview';

import { adminOrNull } from '@/features/admin/server/require-admin';
import { SIGN_IN_URL, SIGN_UP_URL } from '@/features/auth/constants';

const isAdminPage = createRouteMatcher(['/admin(.*)']);

// Routes are protected where they read data (`auth.protect()` in pages,
// `requireUserId()` in route handlers), not here. The URLs tell
// `auth.protect()` where to send signed-out visitors.
export default clerkMiddleware(
  async (auth, request) => {
    // Check before streaming so an inaccessible preview has a real HTTP 404.
    const preview = /^\/p\/([^/]+)\/preview\/?$/.exec(request.nextUrl.pathname);
    if (preview && !(await ownerPreviewProject(preview[1], await auth()))) {
      return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
    }
    // /admin is the exception, only so non-admins get a real 404 status: with
    // Cache Components the layout's `notFound()` runs after the shell has
    // streamed as a 200. The layout still checks too.
    if (isAdminPage(request) && !(await adminOrNull(await auth()))) {
      return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
    }
  },
  { signInUrl: SIGN_IN_URL, signUpUrl: SIGN_UP_URL },
);

export const config = {
  matcher: [
    // Skip Next.js internals and all static files (unless found in search params)
    '/((?!_next|api/inngest|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes, except /api/inngest: Inngest signs its own
    // calls (serve() verifies INNGEST_SIGNING_KEY), so skipping Clerk saves a
    // middleware run per step.
    '/(api(?!/inngest)|trpc)(.*)',
  ],
};

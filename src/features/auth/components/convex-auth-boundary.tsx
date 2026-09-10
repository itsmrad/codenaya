"use client";

import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
} from "convex/react";

import { AuthLoadingView } from "./auth-loading-view";
import { UnauthenticatedView } from "./unauthenticated-view";

/**
 * Prevent authenticated Convex queries from mounting until Convex has accepted
 * Clerk's JWT. Keeping this boundary inside the page (instead of around the
 * root provider's children) also ensures every App Router segment remains in
 * the prerendered tree for Next.js instant-navigation validation.
 */
export const ConvexAuthBoundary = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <>
      <Authenticated>{children}</Authenticated>
      <Unauthenticated>
        <UnauthenticatedView />
      </Unauthenticated>
      <AuthLoading>
        <AuthLoadingView />
      </AuthLoading>
    </>
  );
};

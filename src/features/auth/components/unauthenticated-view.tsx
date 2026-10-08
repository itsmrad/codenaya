"use client";

import Link from "next/link";
import { LogInIcon, ShieldAlertIcon } from "lucide-react";
import { usePathname } from "next/navigation";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SignInButton, SignOutButton, useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export const UnauthenticatedView = () => {
  // Return the user to the page they tried to open once they sign in.
  const pathname = usePathname();
  // Signed in with Clerk but Convex rejected the token: signing in again
  // won't help, so offer a retry or a fresh session instead.
  const { isSignedIn } = useAuth();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-background px-4 py-16">
      <Link href="/" className="flex items-center gap-2.5">
        <img
          src="/logo-alt.svg"
          alt="Codenaya"
          className="size-6 dark:invert-0 invert"
        />
        <span className="text-base font-semibold tracking-tight text-foreground">
          codenaya
        </span>
      </Link>

      <Empty className="w-full max-w-md flex-none rounded-xl border border-solid border-border bg-card p-8 md:p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {isSignedIn ? <ShieldAlertIcon /> : <LogInIcon />}
          </EmptyMedia>
          <EmptyTitle>
            {isSignedIn ? "We couldn't verify your session" : "Sign in to continue"}
          </EmptyTitle>
          <EmptyDescription>
            {isSignedIn
              ? "Your sign-in didn't reach the server. Try again, or sign out and back in."
              : "Sign in to open your projects."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center gap-2">
          {isSignedIn ? (
            <>
              <Button onClick={() => window.location.reload()}>Try again</Button>
              <SignOutButton redirectUrl={pathname}>
                <Button variant="outline">Sign out</Button>
              </SignOutButton>
            </>
          ) : (
            <SignInButton
              mode="modal"
              forceRedirectUrl={pathname}
              signUpForceRedirectUrl={pathname}
            >
              <Button>Sign in</Button>
            </SignInButton>
          )}
        </EmptyContent>
      </Empty>
    </div>
  );
};

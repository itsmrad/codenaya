"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/features/auth/constants";

import { HelpMenu } from "./help-menu";
import { UserMenu } from "./user-menu";

export const AppNavbar = () => {
  // Public pages (the showcase) also use this bar, so signed-out visitors get
  // auth links instead of the user menu.
  const { isSignedIn } = useAuth();

  return (
    <nav className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-border/40 bg-background">
      {/* Left — Brand */}
      <Link href="/" className="flex items-center gap-2.5 group">
        <img
          src="/logo-alt.svg"
          alt="Codenaya"
          className="size-5 dark:invert-0 invert transition-transform duration-200 group-hover:rotate-12"
        />
        <span className="text-sm font-semibold tracking-tight text-foreground">
          codenaya
        </span>
      </Link>

      {/* Right — Help + User */}
      {isSignedIn === false ? (
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link href={SIGN_IN_URL}>Log in</Link>
          </Button>
          <Button asChild size="sm" className="bg-brand text-brand-foreground hover:bg-brand/90">
            <Link href={SIGN_UP_URL}>Sign Up</Link>
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <HelpMenu className="size-8" />
          <UserMenu avatarClassName="size-7" />
        </div>
      )}
    </nav>
  );
};

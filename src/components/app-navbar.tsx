"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

export const AppNavbar = () => {
  return (
    <nav className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-border/40 bg-background">
      {/* Left — Brand */}
      <div className="flex items-center gap-6">
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
      </div>

      {/* Right — User */}
      <UserButton
        appearance={{
          elements: {
            avatarBox: "size-7",
          },
        }}
      />
    </nav>
  );
};

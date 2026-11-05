"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { revealTheme } from "@/lib/reveal-theme";

import { Button } from "@/components/ui/button";
import { CodenayaLogo } from "@/components/codenaya-logo";
import { SiteCursor } from "@/components/ui/site-cursor";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/features/auth/constants";

import { HelpMenu } from "./help-menu";
import { UserMenu } from "./user-menu";

const cell = "flex h-full items-center border-border";

/**
 * The in-app header, in cells like the public navbar. `framed` puts it on the
 * dashboard's 1200px frame; full-width pages leave it off.
 */
export const AppNavbar = ({ framed = false }: { framed?: boolean }) => {
  // Public pages use MarketingNavbar, but in-app pages such as "Project not
  // found" can be reached signed out, so those visitors get auth links.
  const { isSignedIn } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <>
      {/* The public pages' cursor, here too; a sibling so the sticky header can't trap its `fixed`. */}
      <SiteCursor />
      <header className="sticky top-0 z-50 shrink-0 border-b border-border bg-background/80 backdrop-blur-xl backdrop-saturate-150">
        <nav className={`mx-auto flex h-14 w-full items-stretch ${framed ? "max-w-[1200px] border-x border-border" : ""}`}>
          {/* Left — Brand */}
          <Link href="/" className={`${cell} group gap-2.5 border-r px-5`}>
            <CodenayaLogo
              size={22}
              className="transition-transform duration-200 group-hover:rotate-12"
            />
            <span className="text-[15px] font-semibold tracking-tight text-foreground">
              codenaya
            </span>
          </Link>

          {/* Right — Theme + Help + User */}
          <div className="ml-auto flex items-stretch">
            {/* Icons swap in CSS, so the server render matches before the theme is known. */}
            <button
              type="button"
              onClick={(event) =>
              revealTheme(event, () => {
                // next-themes sets the class in an effect; set it now so the
                // transition captures the new theme.
                const next = resolvedTheme === "dark" ? "light" : "dark";
                document.documentElement.classList.remove("light", "dark");
                document.documentElement.classList.add(next);
                document.documentElement.style.colorScheme = next;
                setTheme(next);
              })
            }
              aria-label="Toggle theme"
              className={`${cell} border-l px-4 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground`}
            >
              <Moon className="size-4 dark:hidden" />
              <Sun className="hidden size-4 dark:block" />
            </button>
            {isSignedIn === false ? (
              <>
                <Link
                  href={SIGN_IN_URL}
                  className={`${cell} border-l px-4 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground`}
                >
                  Log in
                </Link>
                <div className={`${cell} border-l px-2`}>
                  <Button asChild size="sm" className="rounded-md bg-brand text-brand-foreground hover:bg-brand/90">
                    <Link href={SIGN_UP_URL}>Sign Up</Link>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <HelpMenu className={`${cell} rounded-none border-l px-4`} />
                <div className={`${cell} border-l px-3`}>
                  <UserMenu avatarClassName="size-7" />
                </div>
              </>
            )}
          </div>
        </nav>
      </header>
    </>
  );
};

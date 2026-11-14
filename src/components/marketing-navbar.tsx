"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { motion, useScroll, useTransform } from "motion/react";
import { Menu } from "lucide-react";
import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/features/auth/constants";
import { CodenayaLogo } from "@/components/codenaya-logo";
import { SiteCursor } from "@/components/ui/site-cursor";
import { GITHUB_REPO_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

import { UserMenu } from "./user-menu";

const NAV_LINKS = [
  { href: "/showcase", label: "Showcase" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
] as const;

/** A link is active on its own page and on any page below it (`/showcase/[id]`). */
const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

const cell = "flex h-full items-center border-border";
const brandButton =
  "h-9 rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground shadow-[inset_0_-4px_8px_rgb(0_0_0/0.12)] hover:bg-brand/90";

/** The current section is marked with the accent: a 6px dot, as status is elsewhere. */
const ActiveDot = () => <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-brand" />;

const Brand = () => (
  <Link
    href="/"
    className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <CodenayaLogo size={22} />
    <span className="text-[15px] font-semibold tracking-tight text-foreground">codenaya</span>
  </Link>
);

/**
 * The one header for every public page: Showcase, Pricing, Docs, plus auth
 * actions. `themeToggle` is the landing page's own theme switch, shown in a
 * cell of its own. `menuClassName` carries the landing theme into the phone
 * menu, which is portaled outside the page's themed wrapper.
 */
export const MarketingNavbar = ({
  themeToggle,
  menuClassName,
}: {
  themeToggle?: ReactNode;
  menuClassName?: string;
}) => {
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const { scrollY, scrollYProgress } = useScroll();
  // Hidden at the top, so a page too short to scroll never shows a full line.
  const progressOpacity = useTransform(scrollY, [0, 1], [0, 1]);

  return (
    <>
      {/* Mounted here so the cursor is on every public page and never in the IDE.
          A sibling, not a child: the header's transform would trap its `fixed`. */}
      <SiteCursor />
      <motion.header
        initial={{ y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl backdrop-saturate-150"
      >
        {/* A hairline under the bar that fills as the page scrolls. */}
        <motion.div
          aria-hidden
          style={{ scaleX: scrollYProgress, opacity: progressOpacity }}
          className="absolute inset-x-0 -bottom-px h-px origin-left bg-brand"
        />
        {/* Cells on the same 1200px frame as the landing page's grid */}
        <nav aria-label="Main" className="mx-auto flex h-14 max-w-[1200px] items-stretch border-x border-border">
          <div className={cn(cell, "px-5 md:border-r")}>
            <Brand />
          </div>

          <ul className="hidden md:flex items-stretch">
            {NAV_LINKS.map(({ href, label }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href} className={cn(cell, "border-r")}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-full items-center gap-2 px-5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-150 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {active && <ActiveDot />}
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>

          {themeToggle && <div className={cn(cell, "ml-auto border-l max-md:hidden")}>{themeToggle}</div>}
          <div className={cn("hidden md:flex items-stretch", !themeToggle && "ml-auto")}>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                cell,
                "gap-2 border-l px-5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <FaGithub className="size-4" /> GitHub
            </a>
            {isSignedIn === true && (
              <div className={cn(cell, "gap-3 border-l px-4")}>
                <Button asChild className={brandButton}>
                  <Link href="/">Dashboard</Link>
                </Button>
                <UserMenu avatarClassName="size-7" />
              </div>
            )}
            {isSignedIn === false && (
              <>
                <Link
                  href={SIGN_IN_URL}
                  className={cn(cell, "border-l px-5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground")}
                >
                  Log in
                </Link>
                <div className={cn(cell, "border-l px-3")}>
                  <Button asChild className={brandButton}>
                    <Link href={SIGN_UP_URL}>Sign up</Link>
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1 pr-2 md:hidden">
            {themeToggle && <div className="h-10">{themeToggle}</div>}
            {isSignedIn === true && <UserMenu avatarClassName="size-7" />}
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Toggle menu" className="rounded-md">
                  <Menu className="size-5" strokeWidth={1.5} />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className={cn("w-full gap-0 text-foreground shadow-none sm:max-w-sm", menuClassName)}>
                <SheetHeader className="h-14 flex-row items-center px-5 py-0">
                  <SheetTitle className="sr-only">Menu</SheetTitle>
                  <SheetDescription className="sr-only">Site navigation</SheetDescription>
                  <Brand />
                </SheetHeader>

                <p className="px-5 pt-8 pb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Navigate
                </p>
                <ul className="flex flex-col border-t border-border mx-5">
                  {NAV_LINKS.map(({ href, label }, index) => {
                    const active = isActive(pathname, href);
                    return (
                      <li key={href} className="border-b border-border">
                        <SheetClose asChild>
                          <Link
                            href={href}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex items-baseline gap-4 py-4 text-3xl font-semibold tracking-[-0.03em] transition-colors duration-150 outline-none focus-visible:text-foreground",
                              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <span aria-hidden className="w-5 font-mono text-[11px] font-normal tracking-normal tabular-nums text-muted-foreground">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            {label}
                            {active && (
                              <span className="ml-auto self-center">
                                <ActiveDot />
                              </span>
                            )}
                          </Link>
                        </SheetClose>
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-auto flex flex-col gap-2 p-5">
                  {isSignedIn === true && (
                    <SheetClose asChild>
                      <Button asChild className={cn(brandButton, "h-11 w-full text-base")}>
                        <Link href="/">Dashboard</Link>
                      </Button>
                    </SheetClose>
                  )}
                  {isSignedIn === false && (
                    <>
                      <SheetClose asChild>
                        <Button asChild variant="outline" className="h-11 w-full rounded-md text-base">
                          <Link href={SIGN_IN_URL}>Log in</Link>
                        </Button>
                      </SheetClose>
                      <SheetClose asChild>
                        <Button asChild className={cn(brandButton, "h-11 w-full text-base")}>
                          <Link href={SIGN_UP_URL}>Sign up</Link>
                        </Button>
                      </SheetClose>
                    </>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </nav>
      </motion.header>
    </>
  );
};

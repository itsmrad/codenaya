"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { motion } from "motion/react";
import { Menu } from "lucide-react";

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

/**
 * The bar's surface: a glass pill floating over the page. Only these classes
 * differ between the floating and the full-width variant of the header.
 */
const SURFACE = {
  header: "px-3 pt-3 md:pt-4",
  nav: "max-w-5xl rounded-full pl-5 pr-2 bg-card/70 dark:bg-card/55 backdrop-blur-xl backdrop-saturate-150 border border-border shadow-[0_8px_32px_-12px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]",
};

const pillButton = "h-9 rounded-full px-4 text-sm font-medium";
const solidButton = "bg-foreground text-background hover:bg-foreground/85";

/** The current section is marked with the accent: a 6px dot, as status is elsewhere. */
const ActiveDot = () => <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-brand" />;

const Brand = () => (
  <Link
    href="/"
    className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <img src="/logo-alt.svg" alt="Codenaya" className="size-6 dark:invert-0 invert" />
    <span className="text-[15px] font-semibold tracking-tight text-foreground">codenaya</span>
  </Link>
);

type MarketingNavbarProps = {
  /**
   * The landing page sets this: the bar is fixed over the hero, which has its
   * own top padding. Other pages get a sticky bar that takes up its own space,
   * so content never sits under it.
   */
  overlay?: boolean;
};

/** The one header for every public page: Showcase, Pricing, Docs, plus auth actions. */
export const MarketingNavbar = ({ overlay = false }: MarketingNavbarProps) => {
  const pathname = usePathname();
  const { isSignedIn } = useAuth();

  return (
    <motion.header
      initial={overlay ? { y: -8, opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
      className={cn("top-0 z-50", overlay ? "fixed inset-x-0" : "sticky", SURFACE.header)}
    >
      <nav
        aria-label="Main"
        className={cn("mx-auto h-14 flex items-center justify-between", SURFACE.nav)}
      >
        <div className="flex items-center gap-5">
          <Brand />
          <span aria-hidden className="hidden md:block h-4 w-px bg-border" />

          <ul className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(({ href, label }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-full px-3 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        </div>

        <div className="hidden md:flex items-center gap-1.5">
          {isSignedIn === true && (
            <>
              <Button asChild variant="ghost" className={pillButton}>
                <Link href="/">Dashboard</Link>
              </Button>
              <UserMenu avatarClassName="size-7" />
            </>
          )}
          {isSignedIn === false && (
            <>
              <Button
                asChild
                variant="ghost"
                className={cn(pillButton, "text-muted-foreground hover:text-foreground")}
              >
                <Link href={SIGN_IN_URL}>Log in</Link>
              </Button>
              <Button asChild className={cn(pillButton, solidButton)}>
                <Link href={SIGN_UP_URL}>Sign Up</Link>
              </Button>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 md:hidden">
          {isSignedIn === true && <UserMenu avatarClassName="size-7" />}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Toggle menu" className="rounded-full">
                <Menu className="size-5" strokeWidth={1.5} />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full gap-0 shadow-none sm:max-w-sm">
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
                    <Button asChild className={cn("h-11 w-full rounded-full text-base", solidButton)}>
                      <Link href="/">Dashboard</Link>
                    </Button>
                  </SheetClose>
                )}
                {isSignedIn === false && (
                  <>
                    <SheetClose asChild>
                      <Button asChild variant="outline" className="h-11 w-full rounded-full text-base">
                        <Link href={SIGN_IN_URL}>Log in</Link>
                      </Button>
                    </SheetClose>
                    <SheetClose asChild>
                      <Button asChild className={cn("h-11 w-full rounded-full text-base", solidButton)}>
                        <Link href={SIGN_UP_URL}>Sign Up</Link>
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
  );
};

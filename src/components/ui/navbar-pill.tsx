"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

export interface NavbarPillProps extends HTMLMotionProps<"header"> {
  children: React.ReactNode;
  overlay?: boolean;
}

/**
 * Floating Pill Navbar container inspired by Aceternity UI.
 * Provides a floating pill layout with backdrop blur, subtle borders, and elevation.
 */
export const NavbarPill = React.forwardRef<
  React.ComponentRef<typeof motion.header>,
  NavbarPillProps
>(({ children, className, overlay = false, ...props }, ref) => {
    return (
      <motion.header
        ref={ref}
        initial={overlay ? { y: -12, opacity: 0 } : false}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "top-0 z-50 px-3 pt-3 md:pt-4 transition-all duration-300",
          overlay ? "fixed inset-x-0" : "sticky",
          className
        )}
        {...props}
      >
        {children}
      </motion.header>
    );
  }
);
NavbarPill.displayName = "NavbarPill";

export interface NavbarPillBodyProps
  extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  ariaLabel?: string;
}

export const NavbarPillBody = React.forwardRef<
  HTMLElement,
  NavbarPillBodyProps
>(({ children, className, ariaLabel = "Main", ...props }, ref) => {
  return (
    <nav
      ref={ref}
      aria-label={ariaLabel}
      className={cn(
        "relative mx-auto h-14 max-w-5xl rounded-full pl-5 pr-2",
        "flex items-center justify-between",
        "bg-background/80 dark:bg-card/75",
        "backdrop-blur-xl backdrop-saturate-150",
        "border border-border/70 dark:border-white/[0.08]",
        "shadow-[0_8px_30px_rgb(0_0_0/0.06)] dark:shadow-[0_12px_36px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.07)]",
        className
      )}
      {...props}
    >
      {children}
    </nav>
  );
});
NavbarPillBody.displayName = "NavbarPillBody";

export interface NavbarPillItemProps {
  href: string;
  label: string;
  active: boolean;
  layoutId?: string;
  className?: string;
  children?: React.ReactNode;
}

export const NavbarPillItem = ({
  href,
  label,
  active,
  layoutId = "navbar-pill-active",
  className,
  children,
}: NavbarPillItemProps) => {
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <li
      className="relative flex items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative z-10 flex h-8 items-center gap-2 rounded-full px-3.5",
          "font-mono text-[11px] uppercase tracking-[0.14em]",
          "transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "text-foreground font-semibold"
            : "text-muted-foreground hover:text-foreground",
          className
        )}
      >
        {active && (
          <motion.span
            layoutId={`${layoutId}-dot`}
            className="inline-block size-1.5 shrink-0 rounded-full bg-brand"
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
          />
        )}
        <span>{label}</span>
        {children}
      </Link>

      {/* Aceternity sliding active pill glider */}
      {active && (
        <motion.div
          layoutId={layoutId}
          className="absolute inset-0 rounded-full bg-neutral-200/60 dark:bg-neutral-800/80 border border-neutral-300/40 dark:border-white/10 shadow-sm"
          transition={{
            type: "spring",
            stiffness: 380,
            damping: 30,
          }}
        />
      )}

      {/* Hover pill glow indicator for inactive items */}
      <AnimatePresence>
        {!active && isHovered && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 rounded-full bg-muted/50 dark:bg-muted/40"
          />
        )}
      </AnimatePresence>
    </li>
  );
};

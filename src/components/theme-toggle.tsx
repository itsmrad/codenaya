"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

const subscribe = () => () => {};

interface ThemeToggleProps {
  className?: string;
}

/**
 * An accessible, animated toggle switch between light and dark mode.
 * Styled as a sleek tactile pill switch matching Codenaya's noir & ivory design.
 */
export const ThemeToggle = ({ className }: ThemeToggleProps) => {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);

  // Default to dark during SSR to prevent hydration flashes
  const isDark = mounted ? resolvedTheme === "dark" : true;

  const toggleTheme = () => {
    setTheme(isDark ? "light" : "dark");
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggleTheme}
      className={cn(
        "relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full border border-border/80 bg-secondary/80 p-0.5 transition-colors duration-200 hover:border-border hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {/* Background track indicators */}
      <span aria-hidden="true" className="flex w-full items-center justify-between px-1.5 pointer-events-none select-none">
        <Sun className="size-3.5 text-amber-500/70 transition-opacity duration-200" />
        <Moon className="size-3.5 text-muted-foreground/70 transition-opacity duration-200" />
      </span>

      {/* Sliding thumb containing active theme icon */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-1 flex size-6 items-center justify-center rounded-full bg-card text-foreground shadow-sm border border-border/50 transition-transform duration-200 ease-out",
          isDark ? "translate-x-6" : "translate-x-0",
        )}
      >
        {isDark ? (
          <Moon className="size-3.5 text-foreground fill-foreground/20" />
        ) : (
          <Sun className="size-3.5 text-amber-500 fill-amber-500/30" />
        )}
      </span>
    </button>
  );
};

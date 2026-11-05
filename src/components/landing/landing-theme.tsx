"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

import { revealTheme } from "@/lib/reveal-theme";

/**
 * The landing page's own light/dark choice, separate from the app theme so it
 * never changes the dashboard or the IDE. Light until the visitor toggles it;
 * remembered in this browser.
 */
type LandingTheme = "light" | "dark";

const STORAGE_KEY = "codenaya-landing-theme";
const listeners = new Set<() => void>();
// The choice for this page load, set only when storage refuses it.
let unsaved: LandingTheme | undefined;

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
};

// Storage can throw (private mode, blocked site data); fall back to light.
const read = (): LandingTheme => {
  if (unsaved) return unsaved;
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
};

export const useLandingTheme = () => {
  const theme = useSyncExternalStore(subscribe, read, (): LandingTheme => "light");

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
      unsaved = undefined;
    } catch {
      unsaved = next;
    }
    listeners.forEach((listener) => listener());
  };

  return { theme, toggle };
};

/** The navbar's sun/moon button for the landing theme. */
export const LandingThemeToggle = ({ theme, onToggle }: { theme: LandingTheme; onToggle: () => void }) => (
  <button
    type="button"
    onClick={(event) => revealTheme(event, onToggle)}
    aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    className="flex h-full items-center justify-center px-4 text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
  >
    {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
  </button>
);

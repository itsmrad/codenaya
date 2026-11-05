"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { MarketingNavbar } from "@/components/marketing-navbar";
import { SmoothScrollProvider } from "@/components/smooth-scroll-provider";
import { LandingFooter } from "./footer";
import { LandingThemeToggle, useLandingTheme } from "./landing-theme";

/**
 * The frame of the pages signed-out visitors see (landing, showcase, pricing,
 * docs): smooth scrolling, the announcement bar, the navbar with the landing
 * theme switch, one framed 1200px column for the content, and the footer.
 */
export const PublicShell = ({ children }: { children: ReactNode }) => {
  const { theme, toggle } = useLandingTheme();

  return (
    <SmoothScrollProvider>
      {/* The landing theme, not the app's: the `light`/`dark` class resets the tokens.
        `overflow-x-clip`, not hidden, so the sticky navbar still sticks. */}
      <div
        className={`${theme} relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground`}
      >
        <Link
          href="/docs"
          className="group flex h-9 items-center justify-center gap-2 border-b border-border px-4 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-brand-text">
            BYOK
          </span>
          <span className="truncate">
            Run the agent on your own OpenRouter, OpenAI, Anthropic or Groq key
          </span>
          <ArrowRight className="size-3 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
        <MarketingNavbar themeToggle={<LandingThemeToggle theme={theme} onToggle={toggle} />} />
        {/* The grid: one framed column, sections stacked on shared borders. */}
        <main className="mx-auto w-full max-w-[1200px] flex-1 border-x border-border">
          {children}
        </main>
        <LandingFooter />
      </div>
    </SmoothScrollProvider>
  );
};

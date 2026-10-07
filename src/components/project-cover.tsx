import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** Small, stable string hash (FNV-1a) so a project always gets the same cover. */
const hashSeed = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Up to two letters from a project name: "arch-routers-page" → "AR". */
export const getInitials = (name: string) => {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
};

/** The cover's hue for a seed, for matching accents (e.g. a monogram). */
export const getCoverHue = (seed: string) => hashSeed(seed) % 360;

const Bar = ({ className, style }: { className?: string; style?: CSSProperties }) => (
  <div className={cn("h-1.5 rounded-full bg-foreground/10", className)} style={style} />
);

/** Skeleton "pages" so covers look like different kinds of apps. */
const LAYOUTS = [
  // Landing page
  () => (
    <div className="flex flex-col items-center gap-1.5 px-[10%] pt-[8%]">
      <div className="h-2.5 w-3/5 rounded-full bg-foreground/20" />
      <Bar className="w-2/5" />
      <div className="mt-1 h-3 w-1/5 rounded-full bg-[var(--cover-accent)]" />
      <div className="mt-2 grid w-full grid-cols-3 gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 rounded-md bg-foreground/[0.06]" />
        ))}
      </div>
    </div>
  ),
  // Dashboard
  () => (
    <div className="flex h-full gap-2 p-2">
      <div className="flex w-1/5 flex-col gap-1.5 pt-1">
        <Bar className="w-full bg-[var(--cover-accent)] opacity-70" />
        <Bar className="w-4/5" />
        <Bar className="w-3/5" />
        <Bar className="w-4/5" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 rounded-md bg-foreground/[0.07]" />
          ))}
        </div>
        <div className="relative flex-1 overflow-hidden rounded-md bg-foreground/[0.05]">
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-0 size-full">
            <polyline
              points="0,32 15,26 30,29 45,18 60,21 75,10 100,14"
              fill="none"
              stroke="var(--cover-accent)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>
    </div>
  ),
  // List / app
  () => (
    <div className="flex flex-col gap-1.5 px-[8%] pt-[7%]">
      <div className="mb-1 flex items-center justify-between">
        <div className="h-2.5 w-1/3 rounded-full bg-foreground/20" />
        <div className="h-3 w-8 rounded-full bg-[var(--cover-accent)]" />
      </div>
      {[0.9, 0.7, 0.8, 0.6].map((width, i) => (
        <div key={i} className="flex items-center gap-1.5 rounded-md bg-foreground/[0.05] px-1.5 py-1">
          <div className="size-2 shrink-0 rounded-sm border border-foreground/20" />
          <Bar style={{ width: `${width * 100}%` }} />
        </div>
      ))}
    </div>
  ),
];

interface ProjectCoverProps {
  /** Stable id the cover is derived from. */
  seed: string;
  className?: string;
}

/**
 * A generated thumbnail for a project without a screenshot: a soft gradient
 * in a hue picked from the seed, with a mini browser window showing one of a
 * few app-like layouts. Deterministic, so the same project always looks the
 * same.
 */
export const ProjectCover = ({ seed, className }: ProjectCoverProps) => {
  const hash = hashSeed(seed);
  const hue = hash % 360;
  const Layout = LAYOUTS[(hash >>> 9) % LAYOUTS.length];

  return (
    <div
      aria-hidden
      className={cn("project-cover relative overflow-hidden", className)}
      style={
        {
          "--cover-h": hue,
          "--cover-h2": (hue + 40 + ((hash >>> 16) % 80)) % 360,
        } as CSSProperties
      }
    >
      <div className="absolute inset-0 bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_12%,transparent)_1px,transparent_1px)] bg-size-[14px_14px] mask-[linear-gradient(to_bottom,black,transparent_80%)]" />
      <div className="absolute inset-x-[9%] top-[14%] -bottom-2 rounded-t-lg border border-foreground/10 bg-background/85 shadow-lg backdrop-blur-sm transition-transform duration-300 ease-out group-hover:-translate-y-1">
        <div className="flex h-4 items-center gap-1 border-b border-foreground/10 px-1.5">
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
          <span className="size-1.5 rounded-full bg-foreground/15" />
        </div>
        <Layout />
      </div>
    </div>
  );
};

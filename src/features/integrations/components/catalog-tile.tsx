"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface CatalogTileProps {
  /** Prefix for the description/meta ids; unique per list. */
  idPrefix: string;
  name: string;
  /** Accessible name of the tile's button. */
  label: string;
  description: string;
  icon: ReactNode;
  /** Small chips shown bottom-left (auth mode, stars, transport…). */
  meta: ReactNode;
  /** Short call to action shown bottom-right. */
  action: string;
  /** Omitted means the tile is shown but cannot be chosen. */
  onSelect?: () => void;
  /** Rendered beside the button rather than inside it, e.g. an external link. */
  corner?: ReactNode;
}

/** One provider tile in the integrations catalog, vetted or community. */
export const CatalogTile = ({
  idPrefix,
  name,
  label,
  description,
  icon,
  meta,
  action,
  onSelect,
  corner,
}: CatalogTileProps) => {
  const disabled = !onSelect;
  return (
    <li className={cn("min-w-0", corner && "relative")}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={`${idPrefix}-description ${idPrefix}-meta`}
        // aria-disabled keeps the tile focusable so its reason can be read.
        aria-disabled={disabled || undefined}
        onClick={onSelect}
        className={cn(
          "flex h-full w-full flex-col gap-2 rounded-lg border border-border/60 bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled ? "cursor-not-allowed opacity-70" : "hover:border-border hover:bg-muted/50",
        )}
      >
        <span className={cn("flex min-w-0 items-center gap-2.5 text-sm font-medium text-foreground", corner && "pr-16")}>
          {icon}
          <span className="truncate">{name}</span>
        </span>
        <span id={`${idPrefix}-description`} className="break-words text-xs leading-relaxed text-muted-foreground">{description}</span>
        <span className="mt-auto flex w-full flex-wrap items-center justify-between gap-2 pt-1">
          <span id={`${idPrefix}-meta`} className="flex flex-wrap items-center gap-1">{meta}</span>
          <span className="text-xs font-medium text-foreground">{action}</span>
        </span>
      </button>
      {corner && <span className="absolute right-3 top-3">{corner}</span>}
    </li>
  );
};

export const TileChip = ({ children }: { children: ReactNode }) => (
  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{children}</span>
);

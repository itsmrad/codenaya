import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The popup look shared by the dashboard's menus (Help, Templates, models,
 * sort): a mono `[ LABEL ]` strip with the brand bar, like the prompt box's
 * label strip, over a padded list with a brand-tinted highlight.
 */
export const MENU_CONTENT =
  "min-w-52 overflow-hidden rounded-md p-0 shadow-[0_16px_48px_-20px_rgb(0_0_0/0.35)]";

export const MENU_ITEM = "gap-2.5 rounded-sm px-2.5 py-2 text-[13px] focus:bg-brand/[0.07]";

export const MenuHeader = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      "flex h-8 items-center gap-2.5 border-b border-border bg-muted/40 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground",
      className,
    )}
  >
    <span aria-hidden className="h-3 w-0.5 bg-brand" />[ {children} ]
  </div>
);

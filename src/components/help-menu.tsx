"use client";

import { BugIcon, CircleHelpIcon, KeyboardIcon } from "lucide-react";

import { MENU_CONTENT, MENU_ITEM, MenuHeader } from "@/components/menu-chrome";
import { useShortcutsDialog } from "@/components/shortcuts-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { REPORT_ISSUE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

interface HelpMenuProps {
  /** Classes for the trigger, so it can match the navbar it sits in. */
  className?: string;
}

/**
 * The "?" menu in the signed-in navbars: the shortcut sheet and a link to
 * report a bug on GitHub.
 */
export const HelpMenu = ({ className }: HelpMenuProps) => {
  const openShortcuts = useShortcutsDialog((state) => state.setOpen);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Help"
          title="Help"
          className={cn(
            "grid place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-muted/50 data-[state=open]:text-foreground",
            className,
          )}
        >
          <CircleHelpIcon aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className={cn(MENU_CONTENT, "w-56")}>
        <MenuHeader>Help</MenuHeader>
        <div className="p-1">
          <DropdownMenuItem onSelect={() => openShortcuts(true)} className={MENU_ITEM}>
            <KeyboardIcon />
            Keyboard shortcuts
            <kbd className="ml-auto font-mono text-[10px] text-muted-foreground">?</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={MENU_ITEM}>
            <a href={REPORT_ISSUE_URL} target="_blank" rel="noopener noreferrer">
              <BugIcon />
              Report a bug
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">GitHub ↗</span>
            </a>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

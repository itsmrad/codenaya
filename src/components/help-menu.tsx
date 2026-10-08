"use client";

import Link from "next/link";
import { BookOpenIcon, BugIcon, CircleHelpIcon, KeyboardIcon } from "lucide-react";

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
 * The "?" menu in the signed-in navbars: docs, the shortcut sheet and a link to
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
            "grid place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
            className,
          )}
        >
          <CircleHelpIcon aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link href="/docs">
            <BookOpenIcon />
            Docs
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openShortcuts(true)}>
          <KeyboardIcon />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={REPORT_ISSUE_URL} target="_blank" rel="noopener noreferrer">
            <BugIcon />
            Report a bug
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

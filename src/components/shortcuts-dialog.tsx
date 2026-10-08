"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { create } from "zustand";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useIsMac } from "@/lib/hooks/use-is-mac";
import {
  SHORTCUTS,
  SHORTCUT_SCOPES,
  formatShortcutKey,
  isShortcutSheetKey,
} from "@/lib/shortcuts";

interface ShortcutsDialogStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Open state of the shortcut sheet, so menus and palettes can open it. */
export const useShortcutsDialog = create<ShortcutsDialogStore>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/**
 * The keyboard shortcut sheet, opened with `?` or Cmd/Ctrl+/ for signed-in
 * users. Mounted once in the root layout.
 */
export const ShortcutsDialog = () => {
  const { isSignedIn } = useAuth();
  const { open, setOpen } = useShortcutsDialog();
  const isMac = useIsMac();

  useEffect(() => {
    if (!isSignedIn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcutSheetKey(event)) return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isSignedIn, setOpen]);

  if (!isSignedIn) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Kbd>?</Kbd> anywhere outside a text field to open this list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {SHORTCUT_SCOPES.map((scope) => (
            <section key={scope} aria-labelledby={`shortcuts-${scope}`}>
              <h3
                id={`shortcuts-${scope}`}
                className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {scope}
              </h3>
              <ul className="divide-y divide-border/60">
                {SHORTCUTS.filter((shortcut) => shortcut.scope === scope).map(
                  (shortcut) => (
                    <li
                      key={shortcut.label}
                      className="flex items-center justify-between gap-4 py-2 text-sm"
                    >
                      <span>{shortcut.label}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {shortcut.keys.map((combo, index) => (
                          <span key={combo.join("+")} className="flex items-center gap-1.5">
                            {index > 0 && <span>or</span>}
                            <KbdGroup>
                              {combo.map((key) => (
                                <Kbd key={key}>{formatShortcutKey(key, isMac)}</Kbd>
                              ))}
                            </KbdGroup>
                          </span>
                        ))}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

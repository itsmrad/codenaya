"use client";

import { useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useIsMac } from "@/lib/hooks/use-is-mac";
import { isCommandPaletteKey } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

export interface DocsSection {
  id: string;
  title: string;
}

/** A section counts as current once its top is this close to the viewport's (#251). */
const ACTIVE_OFFSET_PX = 120;

/**
 * The section being read: the last one whose top has scrolled past the
 * offset, or the last section once the page is scrolled to the bottom (short
 * final sections never reach the top). The first one before any has.
 */
export const activeSectionId = (
  tops: { id: string; top: number }[],
  { offset = ACTIVE_OFFSET_PX, atBottom = false } = {},
) => {
  if (tops.length === 0) return undefined;
  if (atBottom) return tops.at(-1)!.id;
  return tops.filter(({ top }) => top <= offset).at(-1)?.id ?? tops[0].id;
};

const useActiveSection = (sections: DocsSection[]) => {
  const [active, setActive] = useState<string | undefined>(sections[0]?.id);
  useEffect(() => {
    const update = () => {
      const tops = sections.flatMap(({ id }) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActive(activeSectionId(tops, { atBottom }));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections]);
  return active;
};

/**
 * Cmd/Ctrl+K search over the sections, open to signed-out readers too. On
 * /docs it takes the shortcut before the app's command palette (a document
 * listener), which would otherwise open on the same keys.
 */
const DocsSearch = ({ sections }: { sections: DocsSection[] }) => {
  const [open, setOpen] = useState(false);
  const isMac = useIsMac();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteKey(event, isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isMac]);

  const go = (id: string) => {
    setOpen(false);
    // Like following the anchor: scroll to it (sections have scroll-mt) and put it in the URL.
    document.getElementById(id)?.scrollIntoView();
    window.history.pushState(null, "", `#${id}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/60"
      >
        <SearchIcon aria-hidden className="size-3.5" />
        <span className="flex-1 text-left">Search docs</span>
        <KbdGroup className="hidden md:inline-flex">
          <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search docs" description="Jump to a section of the docs">
        <CommandInput placeholder="Search the docs..." />
        <CommandList>
          <CommandEmpty>No matching section.</CommandEmpty>
          {sections.map(({ id, title }) => (
            <CommandItem key={id} value={title} onSelect={() => go(id)}>
              {title}
            </CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
};

/**
 * The docs' "On this page" (#251): search, then the sections with the one
 * being read marked. Sticky beside the content from `md`; a one-line
 * collapsed disclosure above it on phones.
 */
export const DocsToc = ({ sections }: { sections: DocsSection[] }) => {
  const active = useActiveSection(sections);
  const links = (
    <ul className="flex flex-col gap-2 text-sm">
      {sections.map(({ id, title }) => (
        <li key={id}>
          <a
            href={`#${id}`}
            aria-current={id === active ? "location" : undefined}
            className={cn(
              "transition-colors hover:text-foreground",
              id === active ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {title}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <nav aria-label="On this page" className="flex flex-col gap-4 md:sticky md:top-24 md:self-start">
      <DocsSearch sections={sections} />
      <details className="group rounded-md border border-border/60 md:hidden">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 px-3 text-sm [&::-webkit-details-marker]:hidden">
          <span className="text-muted-foreground">On this page:</span>
          <span className="truncate font-medium text-foreground">
            {sections.find(({ id }) => id === active)?.title}
          </span>
        </summary>
        <div className="border-t border-border/60 px-3 py-3">{links}</div>
      </details>
      <div className="hidden md:block">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-foreground">
          On this page
        </h2>
        {links}
      </div>
    </nav>
  );
};

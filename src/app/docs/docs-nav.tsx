"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { SearchIcon } from "lucide-react";

import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useIsMac } from "@/lib/hooks/use-is-mac";
import { isCommandPaletteKey } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type DocsSection = { id: string; title: string };

/**
 * Cmd/Ctrl+K jumps to a section (#251). Listens in the capture phase and prevents the default,
 * so the app's command palette (signed in, same keys) ignores it on /docs.
 */
const DocsSearch = ({ sections }: { sections: DocsSection[] }) => {
  const [open, setOpen] = useState(false);
  const isMac = useIsMac();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteKey(event, isMac)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isMac]);

  const go = (id: string) => {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView();
    window.history.replaceState(null, "", `#${id}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 flex h-9 w-full items-center gap-2 border border-border px-3 text-sm text-muted-foreground transition-colors md:mb-6 hover:bg-muted/50 hover:text-foreground"
      >
        <SearchIcon aria-hidden className="size-3.5" />
        <span className="flex-1 text-left">Search docs</span>
        <KbdGroup className="max-md:hidden">
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

/** The docs' "On this page" list; the section being read is marked in the accent. One line on phones. */
export const DocsNav = ({ sections }: { sections: DocsSection[] }) => {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    // A section is "being read" once its heading passes the upper third of the screen.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const { id } of sections) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sections]);

  const links = (
    <ul className="flex flex-col gap-y-1 text-sm">
      {sections.map(({ id, title }, i) => (
        <motion.li
          key={id}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.2 + i * 0.04 }}
        >
          <a
            href={`#${id}`}
            aria-current={active === id ? "location" : undefined}
            className={cn(
              "relative flex items-center gap-3 border-l py-1.5 pl-4 transition-colors",
              active === id
                ? "border-brand text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden className={cn("font-mono text-[11px]", active === id && "text-brand-text")}>
              {String(i + 1).padStart(2, "0")}
            </span>
            {title}
          </a>
        </motion.li>
      ))}
    </ul>
  );

  return (
    <nav aria-label="On this page" className="md:sticky md:top-20 md:self-start">
      <DocsSearch sections={sections} />
      {/* Phones: a one-line disclosure naming the current section instead of ten wrapped links (#251). */}
      <details className="md:hidden">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 text-sm [&::-webkit-details-marker]:hidden">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">On this page:</span>
          <span className="truncate text-foreground">{sections.find(({ id }) => id === active)?.title}</span>
        </summary>
        <div className="pt-3">{links}</div>
      </details>
      <div className="max-md:hidden">
        <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">On this page</h2>
        {links}
      </div>
    </nav>
  );
};

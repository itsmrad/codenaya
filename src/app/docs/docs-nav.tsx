"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/** The docs' "On this page" list; the section being read is marked in the accent. */
export const DocsNav = ({ sections }: { sections: { id: string; title: string }[] }) => {
  const [active, setActive] = useState(sections[0]?.id);
  const reduceMotion = useReducedMotion();

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

  return (
    <nav aria-label="On this page" className="md:sticky md:top-20 md:self-start">
      <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">On this page</h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm md:flex-col">
        {sections.map(({ id, title }, i) => (
          <motion.li
            key={id}
            initial={reduceMotion ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.2 + i * 0.04 }}
          >
            <a
              href={`#${id}`}
              className={cn(
                "relative flex items-center gap-3 py-1.5 transition-colors md:border-l md:pl-4",
                active === id
                  ? "border-brand text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span aria-hidden className={cn("font-mono text-[10px]", active === id && "text-brand-text")}>
                {String(i + 1).padStart(2, "0")}
              </span>
              {title}
            </a>
          </motion.li>
        ))}
      </ul>
    </nav>
  );
};

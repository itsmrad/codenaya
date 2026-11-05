"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/** Numbered sections on the page; the label reads `[ 01 / 06 ]`. */
const SECTION_COUNT = 6;

const pad = (n: number) => String(n).padStart(2, "0");

/** A `+` where two grid lines cross, on the frame's left or right rail. */
export const GridCross = ({ className }: { className?: string }) => (
  <svg aria-hidden viewBox="0 0 9 9" className={cn("absolute z-10 size-[9px] text-foreground/30", className)}>
    <path d="M4.5 0v9M0 4.5h9" stroke="currentColor" strokeWidth="1" />
  </svg>
);

/** The `[ 01 / 06 ] · LABEL` bar (`[ LABEL ]` without an index) across the grid. */
export const LabelBar = ({ index, label }: { index?: number; label: string }) => (
  <div className="relative flex h-11 items-center gap-3 border-b border-border px-6 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground md:px-8">
    <span aria-hidden className="h-3.5 w-0.5 bg-brand" />
    {index === undefined ? (
      <span>[ {label} ]</span>
    ) : (
      <>
        <span>
          [ <span className="text-brand-text">{pad(index)}</span> / {pad(SECTION_COUNT)} ]
        </span>
        <span aria-hidden>·</span>
        <span>{label}</span>
      </>
    )}
    <GridCross className="-bottom-[5px] -left-[5px]" />
    <GridCross className="-right-[5px] -bottom-[5px]" />
  </div>
);

/**
 * The top of a section: the `[ 01 / 06 ] · LABEL` bar on the grid (`[ LABEL ]`
 * without an index), then a headline with an optional accent phrase and a
 * one-line intro. Pages pass `as="h1"` for their title.
 */
export const SectionHeader = ({
  index,
  label,
  title,
  accent,
  description,
  as: Heading = "h2",
}: {
  index?: number;
  label: string;
  title: ReactNode;
  accent?: string;
  description?: string;
  as?: "h1" | "h2";
}) => {
  const reduceMotion = useReducedMotion();

  return (
    <>
      <LabelBar index={index} label={label} />
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 24, filter: "blur(6px)" }}
        whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="px-6 pt-14 pb-10 md:px-8 md:pt-20 md:pb-14"
      >
        <Heading
          className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-foreground md:text-[3.25rem]"
        >
          {title} {accent && <span className="text-brand">{accent}</span>}
        </Heading>
        {description && (
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">{description}</p>
        )}
      </motion.div>
    </>
  );
};

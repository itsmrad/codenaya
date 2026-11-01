import type { ReactNode } from "react";

import {
  MIN_GITHUB_ACCOUNT_AGE_DAYS,
  PROMO_ENDS_LABEL,
  PROMO_OPUS_RUN_LIMIT,
} from "../github-promo";

const TERMS = [
  `For GitHub accounts at least ${MIN_GITHUB_ACCOUNT_AGE_DAYS} days old.`,
  "One claim per GitHub account and per Codenaya account.",
  `${PROMO_OPUS_RUN_LIMIT} Claude Opus 5.5 runs; each message to the agent is one run.`,
  `Claude Sonnet 5.5 is unlimited until ${PROMO_ENDS_LABEL}.`,
];

/**
 * The promotion page's copy around its action: what's on offer, the terms,
 * and `children`, the step the visitor is on (sign in, connect, claim).
 */
export const PromoView = ({ children }: { children: ReactNode }) => (
  <main className="flex-1 overflow-y-auto bg-background">
    <section className="mx-auto flex max-w-2xl flex-col items-center px-4 pt-16 pb-20 text-center md:pt-24">
      <p className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        Free until {PROMO_ENDS_LABEL}
      </p>
      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl">
        Claude Opus 5.5,
        <br />
        <span className="text-brand-text">on us.</span>
      </h1>
      <p className="mt-5 max-w-md text-base text-muted-foreground">
        {PROMO_OPUS_RUN_LIMIT} free Opus 5.5 runs and unlimited Sonnet 5.5 for developers with a
        GitHub account older than a year.
      </p>

      <div className="mt-10 w-full max-w-md">{children}</div>

      <ul className="mt-12 w-full max-w-md space-y-2 text-left text-sm text-muted-foreground">
        {TERMS.map((term) => (
          <li key={term} className="flex gap-3">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            {term}
          </li>
        ))}
      </ul>
    </section>
  </main>
);

/** The bordered box each step of the page renders in. */
export const PromoStep = ({ children }: { children: ReactNode }) => (
  <div className="rounded-2xl border border-border bg-card p-6 text-left">{children}</div>
);

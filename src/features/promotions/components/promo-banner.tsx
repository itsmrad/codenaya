"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRightIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import {
  PROMO_ENDS_LABEL,
  PROMO_OPUS_RUN_LIMIT,
  PROMO_PATH,
  opusRunsLeft,
} from "../github-promo";
import { usePromoActive, usePromoClaim } from "../hooks/use-promo";

const DISMISSED_KEY = "codenaya:promo-banner-dismissed";

const noopSubscribe = () => () => {};

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The dashboard's pointer to /promo while the promotion runs: an invitation
 * before claiming, the Opus runs left after. Dismissed for good per browser.
 */
export const PromoBanner = () => {
  const active = usePromoActive();
  const claim = usePromoClaim();
  // The server render has no storage: render nothing until the client reads it.
  const storedDismissed = useSyncExternalStore(noopSubscribe, readDismissed, () => true);
  const [dismissed, setDismissed] = useState(false);

  if (!active || claim === undefined || storedDismissed || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: hidden for this visit only.
    }
  };

  return (
    <div className="mb-8 flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm">
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        {claim ? (
          <>
            <span className="text-foreground">
              {opusRunsLeft(claim)} of {PROMO_OPUS_RUN_LIMIT} free Opus 5.5 runs left
            </span>{" "}
            · Sonnet 5.5 unlimited until {PROMO_ENDS_LABEL}
          </>
        ) : (
          <>
            <span className="text-foreground">Claude Opus 5.5, free until {PROMO_ENDS_LABEL}.</span>
            {/* The detail is on /promo; phones get the headline only. */}
            <span className="hidden sm:inline">
              {" "}
              {PROMO_OPUS_RUN_LIMIT} runs plus unlimited Sonnet 5.5 for GitHub accounts over a year
              old.
            </span>
          </>
        )}
      </p>
      {!claim && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={PROMO_PATH}>
            Claim
            <ArrowRightIcon />
          </Link>
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 text-muted-foreground"
        onClick={dismiss}
        aria-label="Dismiss promotion"
      >
        <XIcon />
      </Button>
    </div>
  );
};

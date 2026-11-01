"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { HTTPError } from "ky";
import { CheckIcon } from "lucide-react";
import { FaGithub } from "react-icons/fa";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

import {
  PROMO_CLAIM_ERROR_MESSAGES,
  type PromoClaimErrorCode,
  PROMO_ENDS_LABEL,
  PROMO_OPUS_RUN_LIMIT,
  opusRunsLeft,
} from "../github-promo";
import { claimPromo, usePromoActive, usePromoClaim } from "../hooks/use-promo";
import { PromoStep } from "./promo-view";

const FALLBACK_ERROR = "Couldn't claim the promotion. Please try again.";

/** The claim route's `{ error, code }`, or a generic message. */
const claimRefusal = async (error: unknown) => {
  if (!(error instanceof HTTPError)) return { message: FALLBACK_ERROR };
  const body = await error.response
    .json<{ error?: string; code?: PromoClaimErrorCode }>()
    .catch(() => ({ error: undefined, code: undefined }));
  return { message: body.error ?? FALLBACK_ERROR, code: body.code };
};

/**
 * The signed-in visitor's step: connect GitHub, claim, or see what's left.
 * Linking goes through Clerk, which brings the user back here; the claim
 * route then checks the account's age with GitHub.
 */
export const PromoClaimPanel = () => {
  const { user, isLoaded } = useUser();
  const claim = usePromoClaim();
  const active = usePromoActive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Clerk lists GitHub as linked, but GitHub refused its token (revoked).
  const [githubRefused, setGithubRefused] = useState(false);

  if (!isLoaded || claim === undefined) {
    return (
      <PromoStep>
        <div className="flex justify-center py-6">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      </PromoStep>
    );
  }

  if (claim) {
    const left = opusRunsLeft(claim);
    return (
      <PromoStep>
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckIcon className="size-4 text-brand-text" />
          Claimed with @{claim.githubLogin}
        </p>
        <div className="mt-5 flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Opus 5.5 runs left</span>
          <span className="font-medium tabular-nums text-foreground">
            {left} / {PROMO_OPUS_RUN_LIMIT}
          </span>
        </div>
        <Progress
          value={(left / PROMO_OPUS_RUN_LIMIT) * 100}
          className="mt-2 h-1.5"
          aria-label="Opus 5.5 runs left"
        />
        <p className="mt-4 text-sm text-muted-foreground">
          {active
            ? `Pick Claude Opus 5.5 or Sonnet 5.5 under "Free promotion" in the model menu. Ends ${PROMO_ENDS_LABEL}.`
            : "The promotion has ended."}
        </p>
        <Button asChild className="mt-5 w-full">
          <Link href="/">Start building</Link>
        </Button>
      </PromoStep>
    );
  }

  if (!active) {
    return (
      <PromoStep>
        <p className="text-sm text-muted-foreground">{PROMO_CLAIM_ERROR_MESSAGES.promo_ended}</p>
      </PromoStep>
    );
  }

  const github = githubRefused
    ? undefined
    : user?.externalAccounts.find(
        (account) => account.provider === "github" && account.verification?.status === "verified",
      );

  const connectGithub = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const redirectUrl = window.location.href;
      // An existing link (unfinished, or its token revoked) is re-authorized,
      // not added twice.
      const pending = user.externalAccounts.find((account) => account.provider === "github");
      const account = pending
        ? await pending.reauthorize({ redirectUrl })
        : await user.createExternalAccount({ strategy: "oauth_github", redirectUrl });
      const redirect = account.verification?.externalVerificationRedirectURL;
      if (!redirect) throw new Error("Clerk returned no GitHub redirect");
      window.location.assign(redirect.href);
    } catch {
      setError("Couldn't start connecting GitHub. Please try again.");
      setBusy(false);
    }
  };

  const claimNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await claimPromo();
      toast.success("Claimed! Claude Opus 5.5 is in your model menu.");
    } catch (claimError) {
      const refusal = await claimRefusal(claimError);
      setError(refusal.message);
      // Connecting again re-authorizes the existing link.
      if (refusal.code === "github_not_linked") setGithubRefused(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PromoStep>
      <ol className="space-y-3 text-sm">
        <li className="flex items-center gap-3">
          <StepMark done={Boolean(github)} n={1} />
          <span className={github ? "text-muted-foreground" : "text-foreground"}>
            {github ? `GitHub connected${github.username ? ` as @${github.username}` : ""}` : "Connect GitHub"}
          </span>
        </li>
        <li className="flex items-center gap-3">
          <StepMark done={false} n={2} />
          <span className={github ? "text-foreground" : "text-muted-foreground"}>
            Claim your free runs
          </span>
        </li>
      </ol>

      {github ? (
        <Button className="mt-6 w-full" onClick={claimNow} disabled={busy}>
          {busy && <Spinner />}
          Claim free Opus 5.5
        </Button>
      ) : (
        <Button className="mt-6 w-full" onClick={connectGithub} disabled={busy}>
          {busy ? <Spinner /> : <FaGithub />}
          Connect GitHub
        </Button>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </PromoStep>
  );
};

const StepMark = ({ done, n }: { done: boolean; n: number }) => (
  <span
    aria-hidden
    className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs tabular-nums text-muted-foreground"
  >
    {done ? <CheckIcon className="size-3.5 text-brand-text" /> : n}
  </span>
);

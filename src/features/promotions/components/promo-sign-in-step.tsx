"use client";

import Link from "next/link";
import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import { SIGN_IN_URL } from "@/features/auth/constants";
import { authRedirectUrl } from "@/features/showcase/hooks/use-remix";

import { PROMO_CLAIM_ERROR_MESSAGES, PROMO_PATH } from "../github-promo";
import { usePromoActive } from "../hooks/use-promo";
import { PromoStep } from "./promo-view";

/** The signed-out visitor's step: sign in (GitHub is one option) and come back. */
export const PromoSignInStep = () => {
  const active = usePromoActive();

  return (
    <PromoStep>
      {active ? (
        <Button asChild className="w-full">
          <Link href={authRedirectUrl(SIGN_IN_URL, PROMO_PATH)}>
            <FaGithub />
            Sign in with GitHub to claim
          </Link>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{PROMO_CLAIM_ERROR_MESSAGES.promo_ended}</p>
      )}
    </PromoStep>
  );
};

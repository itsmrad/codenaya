import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/server/require-user-id";
import { getGithubToken } from "@/features/projects/server/github-token";
import {
  PROMO_CLAIM_ERROR_MESSAGES,
  type PromoClaimErrorCode,
  isPromoActive,
} from "@/features/promotions/github-promo";
import { fetchGithubAccount } from "@/features/promotions/server/github-account";
import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";
import {
  PROMO_CLAIM_RATE_LIMIT,
  checkRateLimit,
  rateLimitedResponse,
} from "@/lib/rate-limit";

import { api } from "../../../../../convex/_generated/api";

const CLAIM_ERROR_STATUS: Record<PromoClaimErrorCode, number> = {
  github_not_linked: 400,
  github_unavailable: 502,
  github_too_new: 403,
  github_already_used: 409,
  already_claimed: 409,
  promo_ended: 410,
};

const claimError = (code: PromoClaimErrorCode) =>
  NextResponse.json(
    { error: PROMO_CLAIM_ERROR_MESSAGES[code], code },
    { status: CLAIM_ERROR_STATUS[code] },
  );

const isClaimErrorCode = (reason: unknown): reason is PromoClaimErrorCode =>
  typeof reason === "string" && reason in CLAIM_ERROR_STATUS;

/**
 * Claims the GitHub promotion (ADR 0009) for the signed-in user. The GitHub
 * account is read from GitHub with the user's linked token, so its age can't
 * be forged; Convex then enforces one claim per user and per GitHub account.
 */
export async function POST() {
  const { userId, unauthorized } = await requireUserId();
  if (unauthorized) {
    return unauthorized;
  }

  const rateLimit = checkRateLimit(userId, PROMO_CLAIM_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit);
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    return NextResponse.json({ error: "Internal key not configured" }, { status: 500 });
  }

  if (!isPromoActive(Date.now())) {
    return claimError("promo_ended");
  }

  const token = await getGithubToken(userId);
  let account;
  try {
    account = token ? await fetchGithubAccount(token) : null;
  } catch (error) {
    // GitHub down, rate-limited or slow: nothing was claimed, so a retry is safe.
    console.error("[promo] GitHub account lookup failed", error);
    return claimError("github_unavailable");
  }
  if (!account) {
    return claimError("github_not_linked");
  }

  try {
    await convex.mutation(api.promoClaims.claim, {
      internalKey,
      userId,
      githubUserId: account.id,
      githubLogin: account.login,
      githubCreatedAt: account.createdAt,
    });
  } catch (error) {
    const reason = getAppError(error)?.reason;
    if (isClaimErrorCode(reason)) {
      return claimError(reason);
    }
    throw error;
  }

  return NextResponse.json({ claimed: true });
}

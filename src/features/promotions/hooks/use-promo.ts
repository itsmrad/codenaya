import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import ky from "ky";

import { PROMO_ENDS_AT, isPromoActive } from "../github-promo";
import { api } from "../../../../convex/_generated/api";

/** The signed-in user's promo claim: null if none, undefined while loading. */
export const usePromoClaim = () => useQuery(api.promoClaims.getMine);

/** setTimeout's longest delay (~24.8 days); a later end needs no timer yet. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Whether the promotion is running. Flips to false at the end, so a page or
 * picker left open stops offering it; the server refuses claims and runs
 * either way.
 */
export const usePromoActive = () => {
  const [active, setActive] = useState(() => isPromoActive(Date.now()));

  useEffect(() => {
    if (!active) return;
    const delay = PROMO_ENDS_AT - Date.now();
    if (delay > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => setActive(false), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [active]);

  return active;
};

/** Claims the promotion. A refusal rejects with the route's `{ error, code }`. */
export const claimPromo = () =>
  ky.post("/api/promotions/claim", { timeout: 30_000 }).json<{ claimed: true }>();

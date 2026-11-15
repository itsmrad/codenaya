import { useQuery } from "convex/react";

import { useNow } from "@/hooks/use-now";

import { api } from "../../../../convex/_generated/api";
import { usageView } from "../usage";

/** How often the standing is re-derived, so an open page crosses the UTC reset (#552). */
const CLOCK_MS = 60_000;

/**
 * The signed-in user's credits left, on the client's clock (a query can't
 * read one): grants reset lazily, so the stored account doesn't change at
 * midnight. Undefined while loading.
 */
export const useCreditUsage = () => {
  const account = useQuery(api.credits.getMine);
  const now = useNow(true, CLOCK_MS);
  return account === undefined ? undefined : usageView(account, now);
};

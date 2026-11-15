import { useQuery } from "convex/react";

import { useNow } from "@/hooks/use-now";

import { api } from "../../../../convex/_generated/api";
import { usageView } from "../usage";

/**
 * The signed-in user's credits left, read with the clock at mount (a query
 * can't read one). Undefined while loading.
 */
export const useCreditUsage = () => {
  const account = useQuery(api.credits.getMine);
  const now = useNow(false);
  return account === undefined ? undefined : usageView(account, now);
};

import { useMemo } from "react";
import { useQueries } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Credits a run cost the user. `useQueries` hands back a failure as an Error
 * instead of throwing, so a backend without `getRunCredits` yet only hides the chip.
 */
// shortcut: one subscription per finished run in view. Batching per conversation
// needs a new query over its messages' ledger rows; add it if long chats show load.
export const useRunCredits = (messageId: Id<"messages">): number | null | undefined => {
  const queries = useMemo(
    () => ({ credits: { query: api.credits.getRunCredits, args: { messageId } } }),
    [messageId],
  );
  const result = useQueries(queries).credits;
  return result instanceof Error ? null : result;
};

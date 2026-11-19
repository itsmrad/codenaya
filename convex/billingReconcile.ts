import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import type { Claim } from "./billingQueue";

/**
 * Stage 5 replaces this body with provider reads and the fenced commit. Until then
 * nothing is marked processed, so claimed receipts back off and dead-letter (redrivable).
 */
export const reconcileClaim: (ctx: ActionCtx, customerRef: Id<"billingCustomers">, claim: Claim) => Promise<void> = async () => {};

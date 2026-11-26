import { getFunctionName } from "convex/server";
import { accountAvailability } from "@/features/billing/entitlement";
import type { CreditUsage } from "@/features/billing/credits";

/**
 * For tests that stub `convex.query`: answers the catalog read
 * (`platformCatalog`) with null, so runs use the env provider's curated
 * catalog as before the admin saves one, unless `saved` returns a catalog.
 * The send's credit read (`credits`, ADR 0011) answers a fresh account (null)
 * unless `account` returns one.
 * Every other query goes to `query`, so existing call orders and expectations stay.
 */
export const withEnvPlatform =
  (query: (...args: never[]) => unknown, saved?: () => unknown, account?: () => unknown) =>
  async (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref);
    if (name === "platformCatalog:getForServer") return saved?.() ?? null;
    if (name === "system:getMessageById") {
      const row = await (query as (ref: unknown, args: unknown) => unknown)(ref, args);
      return row && typeof row === "object" && "projectId" in row ? row : null;
    }
    if (name === "credits:getForServer") return account?.() ?? null;
    return (query as (ref: unknown, args: unknown) => unknown)(ref, args);
  };

/** Legacy entitlement fixture for integration tests that use the real model resolver. */
export const withPlatformPermission = (
  mutation: (...args: never[]) => unknown,
  account?: () => unknown,
) => async (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
  if (["billingEntitlement:getForServer", "billingEntitlement:permissionForServer"].includes(getFunctionName(ref))) {
    return accountAvailability({
      account: (account?.() ?? null) as CreditUsage | null,
      enabled: false, periodLots: [], activeLots: [], debt: 0, held: false, deleted: false,
    }, Date.now());
  }
  return (mutation as (ref: unknown, args: unknown) => unknown)(ref, args);
};

import { getFunctionName } from "convex/server";

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
    if (name === "credits:getForServer") return account?.() ?? null;
    return (query as (ref: unknown, args: unknown) => unknown)(ref, args);
  };

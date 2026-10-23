import { getFunctionName } from "convex/server";

/** A Free user with nothing used this month. */
export const UNDER_CAP = {
  planId: "free",
  costMicroUsd: 0,
  tokens: 0,
  costLimitMicroUsd: 3_000_000,
  exceeded: false,
};

/**
 * For tests that stub `convex.query`: answers the active-platform read
 * (`activePlatform`) with the env provider and its catalog, as before the
 * admin saves anything, unless `saved` (given the read's args) returns an admin
 * selection or usage. The run's usage check answers `UNDER_CAP`. Every other
 * query goes to `query`, so existing call orders and expectations stay.
 */
export const withEnvPlatform =
  (query: (...args: never[]) => unknown, saved?: (args: never) => unknown) =>
  async (ref: Parameters<typeof getFunctionName>[0], args: { fallbackProvider?: string }) => {
    const name = getFunctionName(ref);
    if (name === "platformModels:getActiveForServer") {
      return saved?.(args as never) ?? { provider: args.fallbackProvider, config: null };
    }
    if (name === "aiUsage:checkLimit") return UNDER_CAP;
    return (query as (ref: unknown, args: unknown) => unknown)(ref, args);
  };

/** For tests that stub `convex.mutation`: usage records answer `UNDER_CAP`. */
export const withUsageRecorded =
  (mutation: (...args: never[]) => unknown) =>
  async (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
    getFunctionName(ref) === "aiUsage:record"
      ? UNDER_CAP
      : (mutation as (ref: unknown, args: unknown) => unknown)(ref, args);

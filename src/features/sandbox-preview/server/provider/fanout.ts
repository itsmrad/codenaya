import type { ProviderCooldown } from "./failover";
import { withDeadline } from "./helpers";
import type { ProviderId, SandboxMeta, SandboxProvider } from "./types";

type ListQuery = Parameters<SandboxProvider["list"]>[0];

/** How long a non-primary provider's list may take before the fan-out gives up on it. */
export const FALLBACK_LIST_TIMEOUT_MS = 5_000;

/** The primary provider and the failover cooldown, as the registry has them. */
export interface FanoutHealth {
  primary: ProviderId;
  cooldown: ProviderCooldown;
}

/**
 * What to do when a non-primary provider's list fails or times out. Either way it
 * goes into cooldown. "failing" skips it (kill, lookups). "cooling" skips it only
 * if it was already cooling, so the cap fails closed until a failure is known.
 */
export type FanoutPolicy = FanoutHealth & { skip: "failing" | "cooling" };

/**
 * Lists on enabled providers, including those cooling down for creates. The primary
 * always fails closed; without a policy, so does every provider (today's behaviour).
 */
export async function listAll(providers: readonly SandboxProvider[], query: ListQuery, policy?: FanoutPolicy) {
  const lists = await Promise.all(providers.map(async (provider) => {
    const tag = (listed: Awaited<ReturnType<SandboxProvider["list"]>>) =>
      listed.map((sandbox) => ({ ...sandbox, provider: provider.id }));
    if (!policy || provider.id === policy.primary) return tag(await provider.list(query));
    // A shorter caller budget wins; 0 ("no deadline" to some adapters) does not.
    const requestTimeoutMs = Math.min(query.requestTimeoutMs || FALLBACK_LIST_TIMEOUT_MS, FALLBACK_LIST_TIMEOUT_MS);
    try {
      return tag(await withDeadline(provider.list({ ...query, requestTimeoutMs }), requestTimeoutMs, "list"));
    } catch (error) {
      const wasCooling = policy.cooldown.isCoolingDown(provider.id);
      policy.cooldown.coolDown(provider.id);
      if (policy.skip === "cooling" && !wasCooling) throw error;
      // The id only: a provider's error text may echo request details.
      console.warn(`[sandbox-provider] Skipping ${provider.id}: its list failed`);
      return [];
    }
  }));
  return lists.flat();
}

export async function countLive(providers: readonly SandboxProvider[], metadata: SandboxMeta, policy?: FanoutPolicy) {
  return (await listAll(providers, { metadata }, policy)).length;
}

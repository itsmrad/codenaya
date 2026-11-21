import { parseProviderConfig } from "./config";
import { createE2bProvider } from "./e2b";
import { createProviderCooldown, createWithFailover } from "./failover";
import type { FanoutHealth } from "./fanout";
import { selectProviders } from "./select";
import { type CreateOptions, PROVIDER_IDS, type ProviderId, type Sandbox, SandboxConfigError, type SandboxProvider } from "./types";

/**
 * The adapter for `id`. Throws SandboxConfigError when the provider has no key,
 * so an unconfigured provider stays dark. The key is read per call, never at
 * module load, so `next build` works without it.
 */
export const getProvider = (id: ProviderId): SandboxProvider => {
  switch (id) {
    case "e2b": {
      const apiKey = process.env.E2B_API_KEY?.trim();
      if (!apiKey) throw new SandboxConfigError("E2B_API_KEY is not set");
      return createE2bProvider(apiKey);
    }
  }
};

/** Where new sandboxes are created when nothing else asks. */
export const getDefaultProvider = () => getProvider("e2b");

/** The default provider, or null when it is not configured. */
export const getDefaultProviderOrNull = () => {
  try {
    return getDefaultProvider();
  } catch (error) {
    if (error instanceof SandboxConfigError) return null;
    throw error;
  }
};

/**
 * Every provider with a key, listed or not: open sandboxes on any of them still
 * count toward the cap, get killed with their project and can be looked up.
 */
export const getConfiguredProviders = (config = parseProviderConfig()) =>
  PROVIDER_IDS.filter((id) => config.configured[id]).map(getProvider);

/** Whether more than one provider may host a new sandbox, so ids must carry their prefix. */
export const isMultiProvider = (config = parseProviderConfig()) => config.fallbacks.length > 0;

/** Process-local, like the rate limiter: a provider that failed a boot is skipped for a while. */
const cooldown = createProviderCooldown();

/** What the cap, kill and lookup fan-outs need to tolerate a failing non-primary provider. */
export const fanoutHealth = (config = parseProviderConfig()): FanoutHealth => ({ primary: config.primary, cooldown });

/**
 * A new sandbox on SANDBOX_PROVIDER. With SANDBOX_PROVIDER_FALLBACKS set, through
 * failover and its cooldown; without, exactly as before: one create, no cooldown.
 */
export const createSandbox = (opts: CreateOptions, onNotice?: (notice: string) => void, config = parseProviderConfig()) =>
  isMultiProvider(config)
    ? createWithFailover(opts, { providers: selectProviders(config, cooldown).map(getProvider), cooldown, onNotice })
    : getProvider(config.primary).create(opts);

/**
 * Where an agent path finds a project's sandboxes and makes new ones: every provider
 * to list on, the fan-out health for `listAll`, and a create. Each sandbox handle
 * carries its own provider, so its kill and cleanup go back to where it was made.
 */
export interface SandboxPool {
  providers: readonly SandboxProvider[];
  /** Absent: every list fails closed, as with a single provider. */
  health?: FanoutHealth;
  create(opts: CreateOptions): Promise<Sandbox>;
}

/** The configured providers with `createSandbox`'s failover, or null when none has a key. */
export const getSandboxPool = (config = parseProviderConfig()): SandboxPool | null => {
  const providers = getConfiguredProviders(config);
  if (!providers.length) return null;
  return { providers, health: fanoutHealth(config), create: (opts) => createSandbox(opts, undefined, config) };
};

/** One provider as a pool: its own list and create, no fan-out policy, no failover. */
export const singleProviderPool = (provider: SandboxProvider): SandboxPool => ({
  providers: [provider],
  create: (opts) => provider.create(opts),
});

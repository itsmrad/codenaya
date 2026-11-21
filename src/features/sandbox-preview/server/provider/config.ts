import { PROVIDER_IDS, type ProviderId, type SandboxProvider } from "./types";

export interface SandboxProviderConfig {
  primary: ProviderId;
  fallbacks: ProviderId[];
  configured: Readonly<Record<ProviderId, boolean>>;
}

type Environment = Readonly<Record<string, string | undefined>>;
const warned = new Set<string>();

/** The env vars each provider needs. A new adapter adds one entry here. */
export const PROVIDER_KEYS: Readonly<Record<ProviderId, readonly string[]>> = {
  e2b: ["E2B_API_KEY"],
  // The Blaxel SDK reads both from the environment itself.
  blaxel: ["BL_API_KEY", "BL_WORKSPACE"],
};

/** Configured only when every one of its keys is non-empty. */
export const isProviderConfigured = (id: ProviderId, env: Environment = process.env) =>
  PROVIDER_KEYS[id].every((key) => Boolean(env[key]?.trim()));

/** Read per request, never at import time. Warnings contain no env values. */
export function parseProviderConfig(
  env: Environment = process.env,
  warn: (message: string) => void = console.warn,
): SandboxProviderConfig {
  const parseId = (value: string, variable: string): ProviderId | undefined => {
    if ((PROVIDER_IDS as readonly string[]).includes(value)) return value as ProviderId;
    if (!warned.has(variable)) {
      warned.add(variable);
      warn(`[sandbox-provider] Ignoring unknown provider in ${variable}`);
    }
    return undefined;
  };
  const primary = parseId(env.SANDBOX_PROVIDER?.trim() || "e2b", "SANDBOX_PROVIDER") ?? "e2b";
  const fallbacks = (env.SANDBOX_PROVIDER_FALLBACKS ?? "").split(",")
    .map((id) => id.trim()).filter(Boolean)
    .map((id) => parseId(id, "SANDBOX_PROVIDER_FALLBACKS"))
    .filter((id): id is ProviderId => id !== undefined && id !== primary);
  return {
    primary,
    fallbacks: [...new Set(fallbacks)],
    configured: Object.fromEntries(PROVIDER_IDS.map((id) => [id, isProviderConfigured(id, env)])) as Record<ProviderId, boolean>,
  };
}

/** Preserve today's one-hour lifetime, bounded by the provider's account limit. */
export const sandboxTimeoutMs = (provider: Pick<SandboxProvider, "maxSessionMs">) =>
  Math.min(60 * 60 * 1000, provider.maxSessionMs);

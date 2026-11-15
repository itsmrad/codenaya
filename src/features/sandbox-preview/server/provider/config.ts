import { PROVIDER_IDS, type ProviderId, type SandboxProvider } from "./types";

export interface SandboxProviderConfig {
  primary: ProviderId;
  fallbacks: ProviderId[];
  configured: Readonly<Record<ProviderId, boolean>>;
}

type Environment = Readonly<Record<string, string | undefined>>;
const warned = new Set<string>();

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
    configured: { e2b: Boolean(env.E2B_API_KEY?.trim()) },
  };
}

/** Preserve today's one-hour lifetime, bounded by the provider's account limit. */
export const sandboxTimeoutMs = (provider: Pick<SandboxProvider, "maxSessionMs">) =>
  Math.min(60 * 60 * 1000, provider.maxSessionMs);

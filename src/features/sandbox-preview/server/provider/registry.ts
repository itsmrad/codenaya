import { createE2bProvider } from "./e2b";
import { type ProviderId, SandboxConfigError, type SandboxProvider } from "./types";

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

/** Where new sandboxes are created. Selection by env and failover come later (ADR 0015). */
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

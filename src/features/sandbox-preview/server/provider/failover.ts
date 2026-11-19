import { sandboxTimeoutMs } from "./config";
import type { CooldownView } from "./select";
import {
  type CreateOptions, type ProviderId, type SandboxProvider,
  SandboxConfigError, SandboxRateLimitError, SandboxTimeoutError,
} from "./types";

const COOLDOWN_MS = 10 * 60 * 1000;

/** Process-local, shared across boots. Expiry and a successful create reset failures. */
export function createProviderCooldown(now: () => number = Date.now) {
  const states = new Map<ProviderId, { failures: number; until: number }>();
  const view: CooldownView = {
    isCoolingDown(id) {
      const state = states.get(id);
      if (state?.until && state.until <= now()) states.delete(id);
      return (states.get(id)?.until ?? 0) > now();
    },
  };
  return {
    ...view,
    succeeded(id: ProviderId) { states.delete(id); },
    /** A failed fan-out list: cool now, whatever the error, and restart the clock if already cooling. */
    coolDown(id: ProviderId) {
      states.set(id, { failures: (states.get(id)?.failures ?? 0) + 1, until: now() + COOLDOWN_MS });
    },
    failed(id: ProviderId, error: unknown): boolean {
      // Only typed timeouts are known transient failures today. Permanent/unknown
      // errors leave outage evidence intact; only success or expiry resets it.
      if (!(error instanceof SandboxTimeoutError || error instanceof SandboxConfigError || error instanceof SandboxRateLimitError)) return false;
      view.isCoolingDown(id);
      const failures = (states.get(id)?.failures ?? 0) + 1;
      const cool = error instanceof SandboxConfigError || error instanceof SandboxRateLimitError || failures >= 2;
      states.set(id, { failures, until: cool ? now() + COOLDOWN_MS : 0 });
      return cool;
    },
  };
}

export type ProviderCooldown = ReturnType<typeof createProviderCooldown>;

/**
 * Candidates are already selected/ordered. Never retry an ambiguous create in the
 * same boot: typed timeout failures count as transient across consecutive boots.
 */
export async function createWithFailover(opts: CreateOptions, deps: {
  providers: readonly SandboxProvider[];
  cooldown: ProviderCooldown;
  onNotice?: (notice: string) => void;
}) {
  const candidates = deps.providers.filter((provider) => !deps.cooldown.isCoolingDown(provider.id)).slice(0, 2);
  if (!candidates.length) throw new SandboxConfigError("No sandbox provider is configured and available");
  let firstError: unknown;
  for (const [index, provider] of candidates.entries()) {
    try {
      const sandbox = await provider.create({ ...opts, timeoutMs: Math.min(opts.timeoutMs, sandboxTimeoutMs(provider)) });
      deps.cooldown.succeeded(provider.id);
      return sandbox;
    } catch (error) {
      if (index === 0) firstError = error;
      const cool = deps.cooldown.failed(provider.id, error);
      if (!cool || index === candidates.length - 1) throw firstError;
    }
    try {
      deps.onNotice?.(`${provider.id.toUpperCase()} unavailable, continuing on ${candidates[index + 1].id}...`);
    } catch {
      // Terminal notices are best-effort and must never block failover or leak secrets.
    }
  }
  throw firstError;
}

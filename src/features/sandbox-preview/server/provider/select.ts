import type { SandboxProviderConfig } from "./config";
import type { ProviderId } from "./types";

export interface CooldownView {
  isCoolingDown(id: ProviderId): boolean;
}

/** Sticky preference cannot enable an unconfigured or unlisted provider. */
export function selectProviders(
  config: SandboxProviderConfig,
  cooldown: CooldownView,
  preferred?: ProviderId,
): ProviderId[] {
  const enabled = [...new Set([config.primary, ...config.fallbacks])]
    .filter((id) => config.configured[id] && !cooldown.isCoolingDown(id));
  return preferred && enabled.includes(preferred)
    ? [preferred, ...enabled.filter((id) => id !== preferred)]
    : enabled;
}

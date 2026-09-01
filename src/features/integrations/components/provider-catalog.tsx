"use client";

import { EyeIcon, KeyRoundIcon, ServerCogIcon, ShieldIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { listProviders } from "../catalog";
import type { IntegrationAuthMode } from "../types";

/**
 * Sentinel provider id for a user-supplied MCP endpoint.
 *
 * The catalog only describes providers we have verified, so "custom" cannot
 * live there. `/api/integrations/connect` recognises the same literal and
 * requires a `serverUrl` alongside it.
 */
export const CUSTOM_PROVIDER_ID = "custom";

/** Whether a provider can be connected with an API key today. */
export const supportsApiKey = (authModes: readonly IntegrationAuthMode[]) =>
  authModes.includes("api_key");

const authModeLabel = (authModes: readonly IntegrationAuthMode[]) => {
  const oauth = authModes.includes("oauth");
  const apiKey = authModes.includes("api_key");

  if (oauth && apiKey) return "OAuth · API key";
  if (apiKey) return "API key";
  return "OAuth";
};

interface ProviderTileProps {
  displayName: string;
  authLabel: string;
  /** OAuth-only providers are offered but visibly held back. */
  isOAuthOnly: boolean;
  supportsReadOnly: boolean;
  isCustom?: boolean;
  onSelect: () => void;
}

const ProviderTile = ({
  displayName,
  authLabel,
  isOAuthOnly,
  supportsReadOnly,
  isCustom = false,
  onSelect,
}: ProviderTileProps) => {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex flex-col items-start gap-2 p-3 text-left rounded-lg border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isOAuthOnly
          ? "border-dashed border-border/60 bg-muted/20 hover:bg-muted/40"
          : "border-border/60 bg-card hover:bg-muted/50 hover:border-border"
      )}
    >
      <div className="flex items-center gap-2 w-full min-w-0">
        {isCustom ? (
          <ServerCogIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <KeyRoundIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              isOAuthOnly ? "text-muted-foreground/50" : "text-muted-foreground"
            )}
          />
        )}
        <span
          className={cn(
            "text-xs font-medium truncate",
            isOAuthOnly ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {displayName}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {authLabel}
        </span>
        {isOAuthOnly && (
          <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            OAuth only
          </span>
        )}
        {supportsReadOnly && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            <EyeIcon aria-hidden="true" className="size-2.5" />
            Read-only capable
          </span>
        )}
      </div>
    </button>
  );
};

interface ProviderCatalogProps {
  onSelect: (providerId: string) => void;
}

export const ProviderCatalog = ({ onSelect }: ProviderCatalogProps) => {
  const providers = listProviders();

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
        <ShieldIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 mt-0.5 text-muted-foreground"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Pick a provider to give your agent its tools. Providers marked{" "}
          <span className="font-medium">OAuth only</span> cannot be connected
          with an API key yet — OAuth lands in a later step.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {providers.map((provider) => (
          <ProviderTile
            key={provider.id}
            displayName={provider.displayName}
            authLabel={authModeLabel(provider.authModes)}
            isOAuthOnly={!supportsApiKey(provider.authModes)}
            supportsReadOnly={provider.supportsReadOnly}
            onSelect={() => onSelect(provider.id)}
          />
        ))}

        <ProviderTile
          isCustom
          displayName="Custom MCP server"
          authLabel="API key"
          isOAuthOnly={false}
          supportsReadOnly={false}
          onSelect={() => onSelect(CUSTOM_PROVIDER_ID)}
        />
      </div>
    </div>
  );
};

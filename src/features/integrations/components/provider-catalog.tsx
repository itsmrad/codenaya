"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { EyeIcon, SearchIcon, ServerCogIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterProviders, listProviders } from "../catalog";
import type { IntegrationAuthMode } from "../types";

/**
 * Sentinel provider id for a user-supplied MCP endpoint.
 *
 * The catalog only describes providers we have verified, so "custom" cannot
 * live there. `/api/integrations/connect` recognises the same literal and
 * requires a `serverUrl` alongside it.
 */
export const CUSTOM_PROVIDER_ID = "custom";

export const supportsApiKey = (authModes: readonly IntegrationAuthMode[]) =>
  authModes.includes("api_key");

export const supportsOAuth = (authModes: readonly IntegrationAuthMode[]) =>
  authModes.includes("oauth");

const authModeLabel = (authModes: readonly IntegrationAuthMode[]) => {
  if (authModes.includes("none")) return "No sign-in";
  if (supportsOAuth(authModes) && supportsApiKey(authModes)) return "OAuth · API key";
  return supportsApiKey(authModes) ? "API key" : "OAuth";
};

interface ProviderCatalogProps {
  onSelect: (providerId: string) => void;
  connectedProviderIds?: readonly string[];
}

export const ProviderCatalog = ({
  onSelect,
  connectedProviderIds = [],
}: ProviderCatalogProps) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const catalogId = useId();
  const categoryRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    categoryRow.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [category]);
  const categories = [...new Set(listProviders().map((provider) => provider.category))];
  const providers = filterProviders(query, category);

  return (
    <div className="space-y-3">
      <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search integrations"
          placeholder="Search providers or capabilities…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-9"
        />
      </div>
      <div role="group" aria-label="Integration categories" ref={categoryRow} className="flex flex-nowrap gap-1.5 overflow-x-auto p-1">
        {[undefined, ...categories].map((value) => (
          <Button
            key={value ?? "all"}
            type="button"
            variant={category === value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
            className="h-8 shrink-0 rounded-full px-3 text-xs"
          >
            {value ?? "All"}
          </Button>
        ))}
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {providers.length} {providers.length === 1 ? "integration" : "integrations"}
      </p>
      {providers.length > 0 ? (
        <ul aria-label="Integration providers" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => {
            const action = connectedProviderIds.includes(provider.id) ? "Manage" : "Connect";
            return (
              <li key={provider.id} className="min-w-0">
                <button
                  type="button"
                  aria-label={`${action} ${provider.displayName}`}
                  aria-describedby={`${catalogId}-${provider.id}-description ${catalogId}-${provider.id}-auth${provider.supportsReadOnly ? ` ${catalogId}-${provider.id}-read-only` : ""}`}
                  onClick={() => onSelect(provider.id)}
                  className="flex h-full w-full flex-col gap-2 rounded-lg border border-border/60 bg-card p-3 text-left transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="flex items-center gap-2.5 text-sm font-medium text-foreground">
                    <Image src={provider.logo} alt="" width={24} height={24} className="size-6 shrink-0 dark:invert" />
                    {provider.displayName}
                  </span>
                  <span id={`${catalogId}-${provider.id}-description`} className="text-xs leading-relaxed text-muted-foreground">{provider.description}</span>
                  <span className="mt-auto flex w-full flex-wrap items-center justify-between gap-2 pt-1">
                    <span id={`${catalogId}-${provider.id}-auth`} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{authModeLabel(provider.authModes)}</span>
                    {provider.supportsReadOnly && (
                      <span id={`${catalogId}-${provider.id}-read-only`} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        <EyeIcon aria-hidden="true" className="size-2.5" /> Read-only capable
                      </span>
                    )}
                    <span className="text-xs font-medium text-foreground">{action}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
          <p>No integrations match your filters.</p>
          <Button type="button" variant="link" size="sm" onClick={() => { setQuery(""); setCategory(undefined); }}>
            Clear filters
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>Connect a service to give your agent its tools.</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(CUSTOM_PROVIDER_ID)} className="text-xs">
          <ServerCogIcon aria-hidden="true" /> Custom MCP server
        </Button>
      </div>
    </div>
  );
};

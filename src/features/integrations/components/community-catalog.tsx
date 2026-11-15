"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLinkIcon, SearchIcon, ServerIcon, StarIcon, UsersIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  filterCommunityServers,
  listCommunityCategories,
  loadCommunityServers,
  toCustomServerPrefill,
  type CommunityServer,
  type CommunitySort,
  type CustomServerPrefill,
} from "../community-catalog";
import { CatalogTile, TileChip } from "./catalog-tile";

/** Tiles rendered per page; "Show more" adds another page. */
export const COMMUNITY_PAGE_SIZE = 60;

export const STDIO_DISABLED_REASON = "Needs local runtime (coming with #545)";

const AUTH_LABELS: Record<CommunityServer["auth"], string> = {
  oauth: "OAuth",
  "api-key": "API key",
  unknown: "Auth unknown",
};

const formatStars = (stars: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(stars);

const selectClassName =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface CommunityCatalogListProps {
  servers: readonly CommunityServer[];
  onSelect: (prefill: CustomServerPrefill) => void;
}

/** The browsable list, given already-loaded servers. */
export const CommunityCatalogList = ({ servers, onSelect }: CommunityCatalogListProps) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<CommunitySort>("stars");
  const [visible, setVisible] = useState(COMMUNITY_PAGE_SIZE);
  const listId = useId();
  const categories = listCommunityCategories(servers);
  const matches = filterCommunityServers(servers, { query, category: category || undefined, sort });
  const shown = matches.slice(0, visible);
  // Any filter change starts again from the first page.
  const update = <T,>(set: (value: T) => void) => (value: T) => { set(value); setVisible(COMMUNITY_PAGE_SIZE); };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search community servers"
            placeholder="Search community servers…"
            value={query}
            onChange={(event) => update(setQuery)(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <select
            aria-label="Community category"
            value={category}
            onChange={(event) => update(setCategory)(event.target.value)}
            className={`${selectClassName} min-w-0 flex-1 sm:max-w-48`}
          >
            <option value="">All categories</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select
            aria-label="Sort community servers"
            value={sort}
            onChange={(event) => update(setSort)(event.target.value as CommunitySort)}
            className={selectClassName}
          >
            <option value="stars">Most stars</option>
            <option value="name">Name (A–Z)</option>
          </select>
        </div>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {matches.length} community {matches.length === 1 ? "server" : "servers"}
        {matches.length > shown.length && ` · showing ${shown.length}`}
      </p>
      {shown.length > 0 ? (
        <ul aria-label="Community servers" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((server) => {
            const prefill = toCustomServerPrefill(server);
            return (
              <CatalogTile
                key={server.id}
                idPrefix={`${listId}-${server.id}`}
                name={server.name}
                label={prefill ? `Connect ${server.name}` : `${server.name}: ${STDIO_DISABLED_REASON}`}
                description={server.description}
                icon={<ServerIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />}
                meta={(
                  <>
                    <TileChip>
                      <StarIcon aria-hidden="true" className="mr-0.5 inline size-2.5 align-[-1px]" />
                      <span className="sr-only">GitHub stars: </span>{formatStars(server.stars)}
                    </TileChip>
                    <TileChip>{prefill ? `Remote · ${AUTH_LABELS[server.auth]}` : "Local only"}</TileChip>
                    {server.official && <TileChip>Official</TileChip>}
                  </>
                )}
                action={prefill ? "Connect" : STDIO_DISABLED_REASON}
                onSelect={prefill ? () => onSelect(prefill) : undefined}
                corner={(
                  <a
                    href={server.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${server.name} on GitHub (opens in a new tab)`}
                    className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    GitHub <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  </a>
                )}
              />
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
          <p>No community servers match your filters.</p>
          <Button type="button" variant="link" size="sm" onClick={() => { setQuery(""); setCategory(""); setVisible(COMMUNITY_PAGE_SIZE); }}>
            Clear filters
          </Button>
        </div>
      )}
      {matches.length > shown.length && (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setVisible((count) => count + COMMUNITY_PAGE_SIZE)}>
          Show more ({matches.length - shown.length} left)
        </Button>
      )}
    </div>
  );
};

interface CommunityCatalogProps {
  onSelect: (prefill: CustomServerPrefill) => void;
}

/** "Community" section under the vetted grid. Loads its data on mount. */
export const CommunityCatalog = ({ onSelect }: CommunityCatalogProps) => {
  const [servers, setServers] = useState<readonly CommunityServer[]>();
  const [failed, setFailed] = useState(false);
  const headingId = useId();

  useEffect(() => {
    let live = true;
    loadCommunityServers().then(
      (loaded) => { if (live) setServers(loaded); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, []);

  return (
    <section aria-labelledby={headingId} className="space-y-3 border-t border-border/60 pt-4">
      <div className="space-y-1">
        <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-medium">
          <UsersIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          Community — not reviewed; every action asks for approval
        </h3>
        <p className="text-xs text-muted-foreground">
          Popular MCP servers from a public list, ranked by GitHub stars. We have not checked them. Remote servers
          connect as a custom server, and the agent asks you before each tool call.
        </p>
      </div>
      {servers ? (
        <CommunityCatalogList servers={servers} onSelect={onSelect} />
      ) : failed ? (
        <p role="alert" className="text-xs text-muted-foreground">Community servers could not be loaded. Reopen this page to try again.</p>
      ) : (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Loading community servers…
        </p>
      )}
    </section>
  );
};

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { CommunityServer } from "../community-catalog";
import { CommunityCatalog, CommunityCatalogList, COMMUNITY_PAGE_SIZE, STDIO_DISABLED_REASON } from "./community-catalog";
import { ConnectApiKeyForm } from "./connect-api-key-form";
import { ProviderCatalog } from "./provider-catalog";

const server = (index: number, overrides: Partial<CommunityServer> = {}): CommunityServer => ({
  id: `server-${index}`, name: `owner/server-${index}`, repoUrl: `https://github.com/owner/server-${index}`,
  description: `Server number ${index}`, category: index % 2 ? "Databases" : "Search", language: "typescript",
  stars: 1000 - index, starsAsOf: "2026-11-15", official: false, transport: "stdio", auth: "unknown", ...overrides,
});

const render = (servers: CommunityServer[]) =>
  renderToStaticMarkup(createElement(CommunityCatalogList, { servers, onSelect: () => {} }));

it("has its own labelled search, category filter and Most stars sort", () => {
  const html = render([server(1), server(2)]);
  expect(html).toContain('aria-label="Search community servers"');
  expect(html).toContain('aria-label="Community category"');
  expect(html).toContain('<option value="Databases">Databases</option>');
  expect(html).toContain('aria-label="Sort community servers"');
  expect(html).toMatch(/<option value="stars" selected="">Most stars<\/option>/);
  expect(html).toContain('aria-label="Community servers"');
});

it("lists the most-starred first with stars and a GitHub link, one page at a time", () => {
  const servers = Array.from({ length: COMMUNITY_PAGE_SIZE + 5 }, (_, index) => server(COMMUNITY_PAGE_SIZE + 5 - index));
  const html = render(servers);
  expect(html.match(/<li /g)).toHaveLength(COMMUNITY_PAGE_SIZE);
  expect(html.indexOf("owner/server-1<")).toBeLessThan(html.indexOf("owner/server-2<"));
  expect(html).not.toContain(`owner/server-${COMMUNITY_PAGE_SIZE + 1}<`);
  expect(html).toContain("Show more (5 left)");
  expect(html).toContain(`${COMMUNITY_PAGE_SIZE + 5} community servers`);
  expect(html).toContain('href="https://github.com/owner/server-1"');
  expect(html).toContain('aria-label="owner/server-1 on GitHub (opens in a new tab)"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("GitHub stars: </span>999");
});

it("disables stdio-only servers with the local-runtime reason and offers Connect for remote ones", () => {
  const html = render([
    server(1),
    server(2, { name: "owner/remote", transport: "http", remoteUrl: "https://mcp.example.com/mcp", auth: "oauth", official: true }),
  ]);
  expect(html).toContain(`aria-label="owner/server-1: ${STDIO_DISABLED_REASON}" aria-describedby`);
  expect(html).toMatch(/aria-label="owner\/server-1: [^"]+"[^>]*aria-disabled="true"/);
  expect(html).toContain("Local only");
  expect(html).toMatch(/aria-label="Connect owner\/remote"(?![^>]*aria-disabled)/);
  expect(html).toContain("Remote · OAuth");
  expect(html).toContain(">Official<");
});

it("shows an empty state for no matches", () => {
  expect(render([])).toContain("No community servers match your filters.");
});

it("sits below the vetted grid, clearly labelled and loaded lazily", () => {
  const html = renderToStaticMarkup(createElement(ProviderCatalog, { onSelect: () => {} }));
  expect(html.indexOf('aria-label="Integration providers"')).toBeLessThan(html.indexOf("Community — not reviewed; every action asks for approval"));
  expect(renderToStaticMarkup(createElement(CommunityCatalog, { onSelect: () => {} }))).toContain("Loading community servers…");
});

it("opens the custom-server form prefilled, with the community warning", () => {
  const html = renderToStaticMarkup(createElement(ConnectApiKeyForm, {
    providerId: "custom", prefill: { label: "owner/remote", serverUrl: "https://mcp.example.com/mcp" },
  }));
  expect(html).toContain('value="https://mcp.example.com/mcp"');
  expect(html).toContain('value="owner/remote"');
  expect(html).toContain("Community server — not reviewed");
  expect(html).toContain("including ones that claim to be read-only");
});

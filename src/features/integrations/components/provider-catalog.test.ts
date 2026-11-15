import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { listProviders } from "../catalog";
import { ProviderCatalog } from "./provider-catalog";

it("shows all providers with capabilities, local logos and keyboard filters", () => {
  const html = renderToStaticMarkup(createElement(ProviderCatalog, { onSelect: () => {} }));
  expect(html).toContain('type="search"');
  expect(html).toContain('aria-label="Search integrations"');
  expect(html).toContain('aria-label="Integration categories"');
  expect(html).toContain('aria-pressed="true"');
  for (const provider of listProviders()) {
    expect(html).toContain(`aria-label="Connect ${provider.displayName}"`);
    expect(html).toContain(provider.description);
    expect(html).toContain(`src="${provider.logo}"`);
  }
  expect(html.match(/Read-only capable/g)).toHaveLength(listProviders().filter((provider) => provider.supportsReadOnly).length);
  expect(html).toContain("Custom MCP server");
  expect(html).toContain("OAuth · API key");
  expect(html).toContain("No sign-in");
});

it("offers Manage for existing credentials, including those needing reconnect", () => {
  // The catalog receives provider IDs regardless of connection status.
  const html = renderToStaticMarkup(createElement(ProviderCatalog, {
    onSelect: () => {}, connectedProviderIds: ["supabase", "github", "custom"],
  }));
  expect(html).toContain('aria-label="Manage Supabase"');
  expect(html).toContain('aria-label="Manage GitHub"');
  expect(html).not.toContain('aria-label="Connect Supabase"');
  expect(html).toContain('aria-label="Connect Neon"');
});

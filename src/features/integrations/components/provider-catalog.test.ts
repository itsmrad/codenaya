import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { listVisibleProviders } from "../catalog";
import { ProviderCatalog } from "./provider-catalog";

it("shows all providers with capabilities, local logos and keyboard filters", () => {
  const html = renderToStaticMarkup(createElement(ProviderCatalog, { onSelect: () => {} }));
  expect(html).toContain('type="search"');
  expect(html).toContain('aria-label="Search integrations"');
  expect(html).toContain('aria-label="Integration categories"');
  expect(html).toContain('aria-pressed="true"');
  for (const provider of listVisibleProviders()) {
    // Static markup escapes "&" (e.g. "Weights & Biases").
    expect(html).toContain(`aria-label="Connect ${provider.displayName.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(provider.description);
    expect(html).toContain(`src="${provider.logo}"`);
  }
  expect(html.match(/Read-only capable/g)).toHaveLength(listVisibleProviders().filter((provider) => provider.supportsReadOnly).length);
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

it("hides Stripe from new discovery, even for a user already connected to it", () => {
  const html = renderToStaticMarkup(createElement(ProviderCatalog, { onSelect: () => {}, connectedProviderIds: ["stripe"] }));
  expect(html).not.toMatch(/stripe/i);
  expect(html).not.toContain(">Payments<");
});

it("describes read-only capability only on cards that render the badge", () => {
  const html = renderToStaticMarkup(createElement(ProviderCatalog, { onSelect: () => {} }));
  const cards = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  const providers = listVisibleProviders();
  expect(cards).toHaveLength(providers.length);
  for (const [index, provider] of providers.entries()) {
    const card = cards[index];
    const describedBy = card.match(/aria-describedby="([^"]+)"/)![1].split(" ");
    const metaId = describedBy[0].replace(/-description$/, "-meta");
    expect(describedBy).toHaveLength(2);
    expect(describedBy).toContain(metaId);
    expect(card).toContain(`id="${metaId}"`);
    expect(card.includes("Read-only capable")).toBe(provider.supportsReadOnly);
    if (provider.supportsReadOnly) {
      expect(card.indexOf(`id="${metaId}"`)).toBeLessThan(card.indexOf("Read-only capable"));
    }
  }
});

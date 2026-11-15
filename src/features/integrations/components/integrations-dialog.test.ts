import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { CustomServerPrefill } from "../community-catalog";
import type { ConnectionSummary } from "./connection-card";

const state = vi.hoisted(() => ({
  connections: [] as ConnectionSummary[] | undefined,
  hooks: [] as unknown[],
  hookIndex: 0,
  renderingDialog: false,
  selectProvider: undefined as ((id: string) => void) | undefined,
}));
// Keep dialog state across Node renders so loading -> loaded exercises the same opening.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: <T,>(initial: T | (() => T)) => {
    if (!state.renderingDialog) return react.useState(initial);
    const index = state.hookIndex++;
    if (!(index in state.hooks)) state.hooks[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [state.hooks[index], (value: T) => { state.hooks[index] = value; }];
  } };
});
vi.mock("./provider-catalog", async (original) => {
  const catalog = await original<typeof import("./provider-catalog")>();
  return { ...catalog, ProviderCatalog: (props: Parameters<typeof catalog.ProviderCatalog>[0]) => {
    state.selectProvider = props.onSelect;
    return createElement(catalog.ProviderCatalog, props);
  } };
});
vi.mock("../hooks/use-integrations", () => ({ useUserConnections: () => state.connections }));
// Render the dialog body in Node; browser specs cover the real Radix portal/focus.
vi.mock("@/components/ui/dialog", () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { Dialog: wrapper, DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: wrapper };
});
vi.mock("./connection-card", () => ({
  ConnectionCard: ({ connection }: { connection: ConnectionSummary }) => createElement("p", null, `Existing connection: ${connection.label}`),
}));
vi.mock("./connect-api-key-form", () => ({
  ConnectApiKeyForm: ({ providerId }: { providerId: string }) => createElement("p", null, `Connect form: ${providerId}`),
}));
vi.mock("./project-connections-panel", () => ({ ProjectConnectionsPanel: () => null }));

import { IntegrationsDialog } from "./integrations-dialog";

const render = (initialProviderId?: string, initialPrefill?: CustomServerPrefill) => renderToStaticMarkup(createElement(IntegrationsDialog, {
  open: true, onOpenChange: () => {}, initialProviderId, initialPrefill,
}));

beforeEach(() => {
  state.connections = [];
  state.hooks = [];
  state.selectProvider = undefined;
});

const renderOpening = (initialProviderId?: string) => {
  state.hookIndex = 0;
  state.renderingDialog = true;
  let tree;
  try {
    tree = IntegrationsDialog({ open: true, onOpenChange: () => {}, initialProviderId });
  } finally {
    state.renderingDialog = false;
  }
  return renderToStaticMarkup(tree);
};

it("opens straight on the catalog without stacked empty states", () => {
  const html = render();
  expect(html).toContain('aria-label="Search integrations"');
  expect(html).toContain('aria-label="Connect Supabase"');
  expect(html).not.toContain("No connections yet");
  expect(html).not.toContain("Nothing to link yet");
});

it.each(["active", "needs_reauth", "revoked", "error"] as const)("manages an existing %s connection without opening a new connection form", (status) => {
  state.connections = [{
    _id: "existing" as ConnectionSummary["_id"], providerId: "github", label: "My repository", authMode: "oauth",
    serverUrl: "https://example.com/mcp", status, maskedPreview: "****", scopes: [], createdAt: 0, updatedAt: 0,
  }];
  const html = render("github");
  expect(html).toContain("Manage GitHub");
  expect(html).toContain("Existing connection: My repository");
  expect(html).toContain("Add another connection");
  expect(html).not.toContain("Connect form:");
});

it("opens the existing connection form for an unconnected provider", () => {
  expect(render("context7")).toContain("Connect form: context7");
});

it("waits for connection data before choosing a form or management view", () => {
  state.connections = undefined;
  const html = render("github");
  expect(html).toContain("Loading connections...");
  expect(html).not.toContain("Connect form:");
});

it.each(["tile click", "deep link"])("manages a provider selected during loading via %s once connections arrive", (entry) => {
  state.connections = undefined;
  if (entry === "tile click") {
    renderOpening();
    state.selectProvider!("github");
  }
  const initialProviderId = entry === "deep link" ? "github" : undefined;
  expect(renderOpening(initialProviderId)).toContain("Loading connections...");
  state.connections = [{
    _id: "existing" as ConnectionSummary["_id"], providerId: "github", label: "My repository", authMode: "oauth",
    serverUrl: "https://example.com/mcp", status: "active", maskedPreview: "****", scopes: [], createdAt: 0, updatedAt: 0,
  }];
  const html = renderOpening(initialProviderId);
  expect(html).toContain("Manage GitHub");
  expect(html).not.toContain("Connect form:");
});


it("adds a prefilled community server beside existing custom connections", () => {
  state.connections = [{
    _id: "existing" as ConnectionSummary["_id"], providerId: "custom", label: "Existing server", authMode: "api_key",
    serverUrl: "https://example.com/mcp", status: "active", maskedPreview: "****", scopes: [], createdAt: 0, updatedAt: 0,
  }];
  const html = render("custom", { label: "acme/tool", serverUrl: "https://mcp.acme.com/mcp" });
  expect(html).toContain("Add acme/tool");
  expect(html).toContain("Connect form: custom");
  expect(html).not.toContain("Add another connection");
});

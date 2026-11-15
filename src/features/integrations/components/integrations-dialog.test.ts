import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "./connection-card";

const state = vi.hoisted(() => ({ connections: [] as ConnectionSummary[] | undefined }));
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

const render = (initialProviderId?: string) => renderToStaticMarkup(createElement(IntegrationsDialog, {
  open: true, onOpenChange: () => {}, initialProviderId,
}));

beforeEach(() => { state.connections = []; });

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

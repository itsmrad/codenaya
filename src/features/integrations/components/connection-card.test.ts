import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../hooks/use-integrations", () => ({
  useDeleteUserConnection: () => vi.fn(),
  useConnectionProjects: () => [{ projectId: "project", name: "My app", readOnly: true, enabled: true,
    providerScope: { projectRef: "my-database", features: ["docs", "database"] }, allowedTools: ["list_tables"] }],
}));
vi.mock("./connect-api-key-form", () => ({ ConnectApiKeyForm: () => null }));

import { ConnectionCard, type ConnectionSummary } from "./connection-card";

const connection: ConnectionSummary = {
  _id: "connection" as ConnectionSummary["_id"], providerId: "supabase", label: "My connection", authMode: "oauth",
  serverUrl: "https://mcp.supabase.com/mcp", status: "active", maskedPreview: "****", scopes: [],
  createdAt: Date.now(), updatedAt: Date.now(),
};

it.each(["needs_reauth", "revoked", "error"] as const)("offers reconnect for %s", (status) => {
  const html = renderToStaticMarkup(createElement(ConnectionCard, { connection: { ...connection, status } }));
  expect(html).toContain(">Reconnect</button>");
});

it("shows linked project scope and last-used time on an active connection", () => {
  const html = renderToStaticMarkup(createElement(ConnectionCard, { connection: { ...connection, lastUsedAt: Date.now() - 86_400_000 } }));
  expect(html).not.toContain(">Reconnect</button>");
  expect(html).toContain("My app");
  expect(html).toContain('href="/projects/project"');
  expect(html).toContain("Read-only");
  expect(html).toContain("my-database");
  expect(html).toContain("docs, database");
  expect(html).toContain("list_tables");
  expect(html).toContain("Last used 1 day ago");
});

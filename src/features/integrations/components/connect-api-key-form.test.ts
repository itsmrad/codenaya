import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { ConnectApiKeyForm } from "./connect-api-key-form";
import type { Id } from "../../../../convex/_generated/dataModel";

const render = (props: Parameters<typeof ConnectApiKeyForm>[0]) =>
  renderToStaticMarkup(createElement(ConnectApiKeyForm, props));

it("replace-key mode keeps the existing endpoint and name and asks only for the key", () => {
  const html = render({
    providerId: "custom",
    connection: {
      _id: "c1" as Id<"userConnections">,
      authMode: "api_key",
      label: "My server",
      serverUrl: "https://example.com/mcp",
    },
  });
  expect(html).toContain("Reconnect Custom MCP server");
  expect(html).toContain(">Replace key</button>");
  expect(html).not.toContain(">Connect</button>");
  // Endpoint and label can't change on reconnect, so their fields are hidden.
  expect(html).not.toContain('name="serverUrl"');
  expect(html).not.toContain('name="label"');
});

it("new-connection mode still shows the endpoint and label fields", () => {
  const html = render({ providerId: "custom" });
  expect(html).toContain(">Connect</button>");
  expect(html).toContain('name="serverUrl"');
  expect(html).toContain('name="label"');
});

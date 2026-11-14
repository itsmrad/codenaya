import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/features/integrations/hooks/use-integrations", () => ({
  useUserConnections: () => [],
}));
vi.mock("@/features/integrations/components/integrations-dialog", () => ({
  IntegrationsDialog: () => null,
}));

import { listProviders } from "@/features/integrations/catalog";
import { IntegrationsSettings } from "./integrations-settings";

it("shows the full catalog when there are no connections", () => {
  const html = renderToStaticMarkup(createElement(IntegrationsSettings));
  expect(html).toContain("Browse integrations");
  for (const provider of listProviders()) {
    expect(html).toContain(`aria-label="Connect ${provider.displayName}"`);
  }
  expect(html).not.toContain("No connections yet");
});

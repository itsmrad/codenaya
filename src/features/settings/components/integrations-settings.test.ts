import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/features/integrations/hooks/use-integrations", () => ({
  useUserConnections: () => [],
}));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/integrations",
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => search.params,
}));
vi.mock("@/features/integrations/components/integrations-dialog", () => ({
  IntegrationsDialog: ({ open, initialProviderId }: { open: boolean; initialProviderId?: string }) =>
    open ? `Dialog for ${initialProviderId}` : null,
}));

import { listVisibleProviders } from "@/features/integrations/catalog";
import { IntegrationsSettings } from "./integrations-settings";

// renderToStaticMarkup escapes these characters, e.g. "Weights & Biases".
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

it("shows the full catalog when there are no connections", () => {
  const html = renderToStaticMarkup(createElement(IntegrationsSettings));
  expect(html).toContain("Browse integrations");
  for (const provider of listVisibleProviders()) {
    expect(html).toContain(`aria-label="Connect ${escapeHtml(provider.displayName)}"`);
  }
  expect(html).not.toContain("No connections yet");
});

it.each([["supabase", "Dialog for supabase"], ["vercel", null]])("?connect=%s opens that provider's dialog only when it is in the catalog", (id, dialog) => {
  search.params = new URLSearchParams({ connect: id });
  const html = renderToStaticMarkup(createElement(IntegrationsSettings));
  if (dialog) expect(html).toContain(dialog);
  else expect(html).not.toContain("Dialog for");
  search.params = new URLSearchParams();
});

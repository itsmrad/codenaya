import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { getProvider, listProviders } from "../catalog";
import { ConnectionScopeForm } from "./connection-scope-form";

const render = (providerId: string) => {
  const provider = getProvider(providerId);
  return renderToStaticMarkup(createElement(ConnectionScopeForm, {
    provider,
    providerName: provider?.displayName ?? providerId,
    connectionLabel: "My connection",
    initialReadOnly: true,
    initialScope: {},
    onSubmit: async () => {},
    onCancel: () => {},
  }));
};

it.each(["microsoft-learn", "cloudflare-docs"])("%s explains read-only tool approval without claiming a provider setting", (providerId) => {
  const html = render(providerId);
  expect(html).toContain("Only tools on the verified read-only list can run without approval; all other tools require approval.");
  expect(html).not.toContain("is asked for its read-only endpoint");
});

it("keeps the provider read-only endpoint description for authenticated providers", () => {
  expect(render("supabase")).toContain("Supabase is asked for its read-only endpoint");
});

it("keeps the warning for providers without read-only support", () => {
  const provider = listProviders().find((provider) =>
    !provider.supportsReadOnly && !provider.authModes.includes("none")
  );
  if (!provider) throw new Error("Expected an authenticated provider without read-only support");
  expect(render(provider.id)).toContain(`${provider.displayName} has no read-only mode we can request, so this records your intent only — see the note below.`);
});

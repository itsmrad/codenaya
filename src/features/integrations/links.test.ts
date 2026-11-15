import { expect, it } from "vitest";

import { integrationLink, linkedProviderId } from "./links";

it("opens a known provider inside the project", () => {
  expect(integrationLink("stripe", "p1")).toBe("/projects/p1?integrations=stripe");
});

it("opens a known provider on the settings page outside a project", () => {
  expect(integrationLink("supabase")).toBe("/settings/integrations?connect=supabase");
});

it.each(["vercel", "convex", "constructor", ""])("falls back to the plain catalog for %j", (id) => {
  expect(integrationLink(id, "p1")).toBe("/projects/p1?integrations=");
  expect(integrationLink(id)).toBe("/settings/integrations");
});

it("reads only catalog ids back from the URL", () => {
  expect(linkedProviderId("github")).toBe("github");
  expect(linkedProviderId("vercel")).toBeUndefined();
  expect(linkedProviderId(null)).toBeUndefined();
});

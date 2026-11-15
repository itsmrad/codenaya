import { describe, expect, it } from "vitest";

import { getProvider } from "../catalog";
import {
  describeProviderScope,
  normaliseList,
  parseListInput,
} from "./provider-scope";

describe("describeProviderScope", () => {
  it("summarises a query-param string and a list against the provider's options", () => {
    const supabase = getProvider("supabase");
    const total = supabase?.scopeOptions?.features?.length;

    expect(
      describeProviderScope(supabase, {
        projectRef: "  abc123 ",
        features: ["database", "docs"],
      })
    ).toEqual(["Project reference abc123", `2 of ${total} feature groups`]);
  });

  it("counts a header list with no declared options without a total", () => {
    expect(describeProviderScope(getProvider("github"), { toolsets: ["repos"] })).toEqual([
      "1 toolsets",
    ]);
  });

  it("reads path segments as declared string fields, in order", () => {
    expect(
      describeProviderScope(getProvider("sentry"), { projectSlug: "web", orgSlug: "acme" })
    ).toEqual(["Organisation slug acme", "Project slug web"]);
  });

  it("omits blank and undeclared fields", () => {
    expect(
      describeProviderScope(getProvider("supabase"), {
        projectRef: "   ",
        features: [],
        orgSlug: "acme",
      })
    ).toEqual([]);
  });

  it("describes nothing for a custom server or a provider with no scope fields", () => {
    expect(describeProviderScope(undefined, { projectRef: "abc" })).toEqual([]);
    expect(describeProviderScope(getProvider("linear"), { projectRef: "abc" })).toEqual([]);
  });
});

describe("normaliseList", () => {
  it("trims, drops blanks, de-duplicates and sorts", () => {
    expect(normaliseList([" docs", "database", "", "  ", "docs"])).toEqual([
      "database",
      "docs",
    ]);
  });
});

describe("parseListInput", () => {
  it("splits comma-separated input and normalises it", () => {
    expect(parseListInput("repos, issues,,repos ")).toEqual(["issues", "repos"]);
    expect(parseListInput("")).toEqual([]);
  });
});

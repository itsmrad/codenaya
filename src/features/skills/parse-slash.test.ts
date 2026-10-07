import { describe, expect, it } from "vitest";

import { parseSlashSkills, splitSlashSkills } from "./parse-slash";

describe("parseSlashSkills", () => {
  it("reads leading /name tokens", () => {
    expect(parseSlashSkills("/seo-metadata add a sitemap")).toEqual(["seo-metadata"]);
    expect(parseSlashSkills("  /a /b text")).toEqual(["a", "b"]);
    expect(parseSlashSkills("/a")).toEqual(["a"]);
  });

  it("ignores slashes after the text starts", () => {
    expect(parseSlashSkills("add /seo-metadata please")).toEqual([]);
    expect(parseSlashSkills("/a text /b")).toEqual(["a"]);
  });

  it("does not read a path as a skill", () => {
    expect(parseSlashSkills("/src/app is broken")).toEqual([]);
    expect(parseSlashSkills("/a /src/app")).toEqual(["a"]);
    expect(parseSlashSkills("/Seo fix")).toEqual([]);
    expect(parseSlashSkills("/ fix")).toEqual([]);
  });

  it("reads at most 3 tokens and drops duplicates", () => {
    expect(parseSlashSkills("/a /b /c /d go")).toEqual(["a", "b", "c"]);
    expect(parseSlashSkills("/a /a /b go")).toEqual(["a", "b"]);
  });

  it("rejects names over the length limit", () => {
    expect(parseSlashSkills(`/${"a".repeat(65)} go`)).toEqual([]);
  });
});

describe("splitSlashSkills", () => {
  it("returns the text after the tokens", () => {
    expect(splitSlashSkills("/a /b add a sitemap")).toEqual({
      names: ["a", "b"],
      rest: "add a sitemap",
    });
    expect(splitSlashSkills("/a /b /c /d go").rest).toBe("/d go");
  });

  it("leaves text without tokens unchanged", () => {
    expect(splitSlashSkills("  hello /a")).toEqual({ names: [], rest: "  hello /a" });
  });
});

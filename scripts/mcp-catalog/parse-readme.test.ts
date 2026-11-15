import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyExclusions,
  cleanDescription,
  parseExcludeTerms,
  parseGithubUrl,
  parseReadme,
  publisherVouches,
} from "./parse-readme.mjs";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const entries = parseReadme(fixture("README.fixture.md"));
const terms = parseExcludeTerms(fixture("exclude.fixture.txt"));

describe("parseReadme", () => {
  it("reads only top-level entries under Server Implementations, by section", () => {
    expect(entries.map((entry) => [entry.category, entry.name])).toEqual([
      ["Aggregators", "acme/hub"],
      ["Aggregators", "scoped/tool"],
      ["Databases", "mono/repo"],
      ["Databases", "glued/zorblaxtool"],
      ["Databases", "zorblax/official-server"],
      ["Databases", "gitlab/thing"],
    ]);
  });

  it("reads the legend icons after the badge, with or without spaces", () => {
    expect(entries[0]).toMatchObject({
      official: true, languages: ["typescript"], scopes: ["cloud"], os: ["macos", "windows", "linux"],
    });
    expect(entries[1]).toMatchObject({ official: false, languages: ["python"], scopes: ["local"], os: [] });
    expect(entries[2]).toMatchObject({ languages: ["go"], scopes: ["local"] });
    expect(entries[4]).toMatchObject({ languages: ["csharp"], scopes: ["cloud"] });
    expect(entries[5]).toMatchObject({ languages: ["java"] });
  });

  it("turns the description into plain text after either dash", () => {
    expect(entries[0].description).toBe("One server for many apps, works with Zorblax and Quuxly.");
    expect(entries[1].description).toBe("Local tool runner.");
    expect(entries[2].description).toBe("Postgres server in a monorepo.");
  });

  it("shortens long descriptions on a word boundary", () => {
    const long = cleanDescription(`${"word ".repeat(80)}end`);
    expect(long.length).toBeLessThanOrEqual(221);
    expect(long.endsWith("word…")).toBe(true);
  });
});

describe("parseGithubUrl", () => {
  it("normalises repos and keeps monorepo folders", () => {
    expect(parseGithubUrl("https://github.com/Mono/Repo/tree/main/servers/pg")).toEqual({
      owner: "Mono", repo: "Repo", key: "mono/repo", subpath: "servers/pg",
    });
    expect(parseGithubUrl("https://github.com/acme/hub.git")).toMatchObject({ key: "acme/hub", subpath: "" });
    expect(parseGithubUrl("https://gitlab.com/group/thing")).toBeNull();
  });
});

describe("exclusions", () => {
  it("ignores comments and blank lines in the term file", () => {
    expect(terms).toEqual(["Zorblax", "quuxly"]);
  });

  it("drops entries named after a term, even glued into a repo name", () => {
    const { kept, dropped } = applyExclusions(entries, terms);
    expect(dropped).toBe(2);
    expect(kept.map((entry: { name: string }) => entry.name)).toEqual(["acme/hub", "scoped/tool", "mono/repo", "gitlab/thing"]);
  });

  it("replaces whole-word terms in descriptions, case-insensitively, without repeats", () => {
    const { kept } = applyExclusions(entries, terms);
    expect(kept[0].description).toBe("One server for many apps, works with MCP clients.");
    expect(JSON.stringify(kept)).not.toMatch(/zorblax|quuxly/i);
  });

  it("leaves a term that only appears inside a longer description word", () => {
    const [entry] = applyExclusions([{ ...entries[1], description: "Zorblaxian tools" }], terms).kept;
    expect(entry.description).toBe("Zorblaxian tools");
  });
});

describe("publisherVouches", () => {
  const repo = { owner: "acme", repo: "hub", key: "acme/hub", subpath: "" };

  it("trusts the repo owner's GitHub namespace and the remote's own domain", () => {
    expect(publisherVouches("io.github.acme/hub", repo, "https://anything.example/mcp")).toBe("owner");
    expect(publisherVouches("com.acme/hub", repo, "https://mcp.acme.com/mcp")).toBe("domain");
  });

  it("rejects a third party claiming someone else's repo", () => {
    expect(publisherVouches("io.github.mallory/hub", repo, "https://evil.example/mcp")).toBeNull();
    expect(publisherVouches("com.mallory/hub", repo, "https://mcp.acme.com/mcp")).toBeNull();
  });
});

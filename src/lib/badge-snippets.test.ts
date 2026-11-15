import { describe, expect, it } from "vitest";

import { importPath } from "@/features/projects/utils/github-repo";
import { badgeSnippets } from "./badge-snippets";

const ORIGIN = "https://codenaya.example";

describe("importPath", () => {
  it("builds the deep link for a repo slug", () => {
    expect(importPath("octocat/Hello-World")).toBe("/import?repo=octocat/Hello-World");
  });
});

describe("importPath encoding", () => {
  it("encodes each segment but keeps the slash readable", () => {
    expect(importPath("a b/c&d#e")).toBe("/import?repo=a%20b/c%26d%23e");
  });
});

describe("badgeSnippets", () => {
  it("builds the Open in badge for a repo", () => {
    expect(badgeSnippets("open", ORIGIN, importPath("octocat/Hello-World"))).toEqual({
      markdown:
        "[![Open in Codenaya](https://codenaya.example/badges/open-in-codenaya.svg)](https://codenaya.example/import?repo=octocat/Hello-World)",
      html: '<a href="https://codenaya.example/import?repo=octocat/Hello-World"><img src="https://codenaya.example/badges/open-in-codenaya.svg" alt="Open in Codenaya" height="28"></a>',
    });
  });

  it("builds the Remix badge for a showcase page", () => {
    const { markdown, html } = badgeSnippets("remix", ORIGIN, "/showcase/abc123");
    expect(markdown).toBe(
      "[![Remix on Codenaya](https://codenaya.example/badges/remix-on-codenaya.svg)](https://codenaya.example/showcase/abc123)",
    );
    expect(html).toBe(
      '<a href="https://codenaya.example/showcase/abc123"><img src="https://codenaya.example/badges/remix-on-codenaya.svg" alt="Remix on Codenaya" height="28"></a>',
    );
  });

  it("ignores a trailing slash on the origin", () => {
    expect(badgeSnippets("remix", `${ORIGIN}/`, "/showcase/x").markdown).toContain(
      "(https://codenaya.example/showcase/x)",
    );
  });
});

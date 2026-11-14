import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocsNav } from "./docs-nav";

describe("DocsNav (#251)", () => {
  const html = renderToStaticMarkup(
    createElement(DocsNav, {
      sections: [
        { id: "getting-started", title: "Getting started" },
        { id: "env-vars", title: "Environment variables" },
      ],
    }),
  );

  it("is a labelled nav with a search button and a link per section", () => {
    expect(html).toContain('aria-label="On this page"');
    expect(html).toContain("Search docs");
    expect(html.match(/href="#env-vars"/g)).toHaveLength(2); // phone list and desktop list
  });

  it("marks the first section as current until the reader scrolls", () => {
    expect(html).toMatch(/href="#getting-started" aria-current="location"/);
    expect(html).not.toMatch(/href="#env-vars" aria-current/);
  });

  it("collapses the list into a closed one-line disclosure on phones", () => {
    expect(html).toMatch(/<details class="md:hidden">/);
    expect(html).toMatch(/<summary[^>]*>.*Getting started.*<\/summary>/);
  });
});

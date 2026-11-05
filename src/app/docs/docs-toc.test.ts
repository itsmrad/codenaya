import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocsToc, activeSectionId } from "./docs-toc";

const tops = (...values: number[]) => values.map((top, index) => ({ id: `s${index}`, top }));

describe("activeSectionId (#251)", () => {
  it("is the first section before any has reached the top", () => {
    expect(activeSectionId(tops(300, 900, 1500))).toBe("s0");
  });

  it("is the last section whose top has scrolled past the offset", () => {
    expect(activeSectionId(tops(-800, 40, 600))).toBe("s1");
    expect(activeSectionId(tops(-800, 119, 600))).toBe("s1");
    expect(activeSectionId(tops(-800, 121, 600))).toBe("s0");
  });

  it("is the last section at the bottom of the page, even if it never reached the top", () => {
    expect(activeSectionId(tops(-1200, -400, 500), { atBottom: true })).toBe("s2");
  });

  it("has nothing to mark without sections", () => {
    expect(activeSectionId([])).toBeUndefined();
  });
});

describe("DocsToc", () => {
  const html = renderToStaticMarkup(
    createElement(DocsToc, {
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

  it("collapses the list into a one-line disclosure on phones", () => {
    expect(html).toMatch(/<details[^>]*md:hidden/);
    expect(html).not.toMatch(/<details[^>]* open/);
  });
});

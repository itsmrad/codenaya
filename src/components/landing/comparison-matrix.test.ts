import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingComparison } from "./comparison-matrix";

describe("LandingComparison", () => {
  it("gives every Yes/No icon text a screen reader can read", () => {
    const html = renderToStaticMarkup(createElement(LandingComparison));
    const icons = (html.match(/<svg/g) ?? []).length;
    const labels = (html.match(/<span class="sr-only">(Yes|No)<\/span>/g) ?? []).length;
    expect(labels).toBeGreaterThan(0);
    expect(labels).toBe(icons);
  });
});

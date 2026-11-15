import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorRetryView } from "./error-retry-view";

const render = (className?: string) =>
  renderToStaticMarkup(
    createElement(ErrorRetryView, { retry: () => {}, description: "It broke.", className }),
  );

describe("ErrorRetryView", () => {
  it("fills the screen by default", () => {
    const html = render();
    expect(html).toContain("h-screen");
    expect(html).toContain("It broke.");
    expect(html).toContain("Try again");
  });

  it("lets a page layout replace the full-screen height", () => {
    const html = render("h-auto py-16");
    expect(html).toContain("h-auto");
    expect(html).not.toContain("h-screen");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviewTerminal } from "./preview-terminal";

// xterm itself only starts in the browser (in an effect); this renders the
// panel's own controls around it (#480).
const render = (output: string) =>
  renderToStaticMarkup(createElement(PreviewTerminal, { output, onClear: () => {} }));

const button = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];

describe("PreviewTerminal controls (#480)", () => {
  it("offers Copy and Clear for the logs", () => {
    const html = render("VITE ready\n");
    expect(button(html, "Copy logs")).not.toContain(" disabled=\"\"");
    expect(button(html, "Clear logs")).not.toContain(" disabled=\"\"");
  });

  it("disables them while there are no logs", () => {
    const html = render("");
    expect(button(html, "Copy logs")).toContain(" disabled=\"\"");
    expect(button(html, "Clear logs")).toContain(" disabled=\"\"");
  });

  it("shows Jump to latest only once the user scrolls up", () => {
    expect(render("VITE ready\n")).not.toContain("Jump to latest");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: () => {} }) }));

import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  it("stays invisible until the browser knows the theme, instead of guessing dark", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle));
    expect(html).toMatch(/<button[^>]*class="[^"]*\binvisible\b/);
    expect(html).not.toContain("translate-x-6");
  });
});

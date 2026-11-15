import { describe, expect, it } from "vitest";

import { buildProjectInstructionsSection } from "./instructions";
import {
  THEME_PRESETS,
  buildDesignTokensSection,
  contrastRatio,
  foregroundFor,
  hexToHsl,
  meetsContrastAA,
  sameTheme,
  validateTheme,
  type ProjectTheme,
} from "./theme";

const theme: ProjectTheme = {
  primary: "#2563eb",
  accent: "#e0f2fe",
  radius: 0.5,
  font: "dm-sans",
  defaultMode: "dark",
};

describe("hexToHsl", () => {
  it.each([
    ["#2563eb", "hsl(221 83% 53%)"],
    ["#ffffff", "hsl(0 0% 100%)"],
    ["#000000", "hsl(0 0% 0%)"],
    ["#ff0000", "hsl(0 100% 50%)"],
    ["#00ff00", "hsl(120 100% 50%)"],
    ["#7c3aed", "hsl(262 83% 58%)"],
  ])("converts %s to %s", (hex, hsl) => {
    expect(hexToHsl(hex)).toBe(hsl);
  });
});

describe("contrast", () => {
  it("matches the WCAG ratios for black and white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1);
  });

  it("picks the more readable text colour and flags colours that fail AA", () => {
    expect(foregroundFor("#2563eb")).toBe("#ffffff");
    expect(foregroundFor("#fde047")).toBe("#0a0a0a");
    expect(meetsContrastAA("#2563eb")).toBe(true);
    // Mid grey: neither white nor near-black text reaches 4.5:1.
    expect(meetsContrastAA("#787878")).toBe(false);
  });

  it("keeps every preset's primary at AA", () => {
    for (const preset of THEME_PRESETS) {
      expect(validateTheme(preset.theme)).toBeNull();
      expect(meetsContrastAA(preset.theme.primary)).toBe(true);
    }
  });
});

describe("sameTheme", () => {
  it("compares field by field, whatever the key order or hex case", () => {
    // Key order as Convex returns it (sorted), unlike the presets.
    const fromConvex: ProjectTheme = {
      accent: "#E0F2FE",
      defaultMode: "dark",
      font: "dm-sans",
      primary: "#2563eb",
      radius: 0.5,
    };
    expect(JSON.stringify(fromConvex)).not.toBe(JSON.stringify(theme));
    expect(sameTheme(fromConvex, theme)).toBe(true);
    expect(sameTheme(null, null)).toBe(true);
    expect(sameTheme(theme, null)).toBe(false);
    expect(sameTheme(theme, { ...theme, radius: 0.75 })).toBe(false);
  });
});

describe("buildDesignTokensSection", () => {
  it("is injected only when a valid theme is set", () => {
    expect(buildDesignTokensSection(undefined)).toBe("");
    expect(buildDesignTokensSection({ ...theme, primary: "blue" })).toBe("");
    expect(buildProjectInstructionsSection(undefined)).toBe("");
    expect(buildProjectInstructionsSection(undefined, undefined, theme)).toContain(
      "## Design tokens (project theme)",
    );
  });

  it("writes the theme as HSL shadcn variables with the font and mode", () => {
    const section = buildDesignTokensSection(theme);

    expect(section).toContain("--primary: hsl(221 83% 53%);");
    expect(section).toContain("--primary-foreground: hsl(0 0% 100%);");
    expect(section).toContain("--accent: hsl(204 94% 94%);");
    expect(section).toContain("--accent-foreground: hsl(0 0% 4%);");
    expect(section).toContain("--radius: 0.5rem;");
    expect(section).toContain('"@fontsource/dm-sans"');
    expect(section).toContain('class="dark" on <html>');
  });

  it("follows the project instructions", () => {
    const section = buildProjectInstructionsSection("All prices in INR.", undefined, theme);

    expect(section.indexOf("</project_instructions>")).toBeLessThan(
      section.indexOf("## Design tokens"),
    );
  });
});

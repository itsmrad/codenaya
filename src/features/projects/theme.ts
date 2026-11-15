/**
 * Project theme (#302): brand colours, font, corner radius and default mode
 * that every agent run in the project applies.
 *
 * Plain TS with no imports so the Convex mutation, the agent prompt and the UI
 * validate and convert with the same rules.
 */

/** Fonts the agent can load from @fontsource (Vite) or next/font/google (Next.js). */
export const THEME_FONTS = [
  { id: "inter", label: "Inter", family: "Inter", fallback: "sans-serif" },
  { id: "dm-sans", label: "DM Sans", family: "DM Sans", fallback: "sans-serif" },
  { id: "manrope", label: "Manrope", family: "Manrope", fallback: "sans-serif" },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans", family: "Plus Jakarta Sans", fallback: "sans-serif" },
  { id: "space-grotesk", label: "Space Grotesk", family: "Space Grotesk", fallback: "sans-serif" },
  { id: "lora", label: "Lora (serif)", family: "Lora", fallback: "serif" },
] as const;

export type ThemeFontId = (typeof THEME_FONTS)[number]["id"];
export type ThemeMode = "light" | "dark" | "system";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
/** `--radius` in rem. */
export const THEME_RADIUS_MAX = 1;

export interface ProjectTheme {
  /** `#rrggbb` */
  primary: string;
  /** `#rrggbb` */
  accent: string;
  radius: number;
  font: string;
  defaultMode: ThemeMode;
}

export const THEME_PRESETS: readonly { name: string; theme: ProjectTheme }[] = [
  { name: "Slate", theme: { primary: "#0f172a", accent: "#f1f5f9", radius: 0.625, font: "inter", defaultMode: "light" } },
  { name: "Ocean", theme: { primary: "#2563eb", accent: "#e0f2fe", radius: 0.5, font: "dm-sans", defaultMode: "light" } },
  { name: "Forest", theme: { primary: "#047857", accent: "#d1fae5", radius: 0.75, font: "manrope", defaultMode: "light" } },
  { name: "Grape", theme: { primary: "#7c3aed", accent: "#ede9fe", radius: 1, font: "plus-jakarta-sans", defaultMode: "system" } },
  { name: "Ember", theme: { primary: "#ea580c", accent: "#ffedd5", radius: 0.25, font: "space-grotesk", defaultMode: "dark" } },
  { name: "Editorial", theme: { primary: "#be123c", accent: "#ffe4e6", radius: 0, font: "lora", defaultMode: "light" } },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const fontById = (id: string) => THEME_FONTS.find((font) => font.id === id);

/** Returns why the theme is invalid, or null when it is valid. */
export function validateTheme(theme: ProjectTheme): string | null {
  if (!HEX_COLOR.test(theme.primary) || !HEX_COLOR.test(theme.accent)) {
    return "Colours must be hex values like #2563eb";
  }
  if (!(theme.radius >= 0 && theme.radius <= THEME_RADIUS_MAX)) {
    return `Radius must be between 0 and ${THEME_RADIUS_MAX}rem`;
  }
  if (!fontById(theme.font)) return "Choose a font from the list";
  if (!THEME_MODES.includes(theme.defaultMode)) return "Mode must be light, dark or system";
  return null;
}

const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/** `[hue°, saturation%, lightness%]`, unrounded. */
const toHsl = (hex: string): [number, number, number] => {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
};

const formatHsl = ([h, s, l]: [number, number, number]) =>
  `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

/** `#2563eb` → `hsl(221 83% 53%)`, ready for a shadcn CSS variable. */
export const hexToHsl = (hex: string) => formatHsl(toHsl(hex));

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio between two `#rrggbb` colours, 1 to 21. */
export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#0a0a0a";

/** The text colour (white or near-black) that reads best on `background`. */
export const foregroundFor = (background: string) =>
  contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT)
    ? LIGHT_TEXT
    : DARK_TEXT;

/** WCAG AA for normal text. */
export const meetsContrastAA = (background: string) =>
  contrastRatio(background, foregroundFor(background)) >= 4.5;

/** The accent's dark-mode counterpart: same hue, dark enough for hover backgrounds. */
const darkAccent = (hex: string): [number, number, number] => {
  const [h, s] = toHsl(hex);
  return [h, Math.min(s, 40), 18];
};

/** What "Apply theme" sends to the chat: re-apply the tokens, touch nothing else. */
export const APPLY_THEME_MESSAGE =
  "Apply the project theme from the Design tokens section to this app. Change only the theme: " +
  "the CSS variables in src/index.css (or src/app/globals.css in Next.js), plus the font import " +
  "and the dark-mode class if they differ. Don't change any other files.";

/**
 * The system prompt's design tokens section (#302): the theme as shadcn CSS
 * variables plus the font and default mode. Empty when no theme is set.
 */
export function buildDesignTokensSection(theme?: ProjectTheme): string {
  if (!theme || validateTheme(theme)) return "";
  const font = fontById(theme.font)!;
  const primary = hexToHsl(theme.primary);
  const primaryForeground = hexToHsl(foregroundFor(theme.primary));
  const accentDark = darkAccent(theme.accent);
  const mode = {
    light: 'light: no "dark" class on <html>.',
    dark: 'dark: class="dark" on <html> (index.html in Vite, the root layout in Next.js).',
    system:
      'system: add "dark" to <html> when prefers-color-scheme is dark, with a small inline script in <head> so there is no flash.',
  }[theme.defaultMode];

  return [
    "\n\n## Design tokens (project theme)",
    "The project owner set this theme. Apply it in every app in this project and keep it: " +
      "don't change these values unless the user's current request asks for a different colour, font, radius or mode. " +
      "In a new app, write them before building pages.",
    "CSS variables in src/index.css (Vite) or src/app/globals.css (Next.js). Replace only these, keep every other variable:",
    "```css",
    ":root {",
    `  --primary: ${primary};`,
    `  --primary-foreground: ${primaryForeground};`,
    `  --accent: ${hexToHsl(theme.accent)};`,
    `  --accent-foreground: ${hexToHsl(foregroundFor(theme.accent))};`,
    `  --ring: ${primary};`,
    `  --radius: ${theme.radius}rem;`,
    "}",
    ".dark {",
    `  --primary: ${primary};`,
    `  --primary-foreground: ${primaryForeground};`,
    `  --accent: ${formatHsl(accentDark)};`,
    `  --accent-foreground: ${hexToHsl(LIGHT_TEXT)};`,
    `  --ring: ${primary};`,
    "}",
    "```",
    `Font: ${font.family}. Set \`--font-sans: "${font.family}", ui-${font.fallback === "serif" ? "serif" : "sans-serif"}, ${font.fallback};\` in @theme inline. ` +
      `Vite: add "@fontsource/${font.id}" to package.json and import its 400, 500, 600 and 700 weights in src/main.tsx, replacing other @fontsource imports. ` +
      `Next.js: load it with next/font/google.`,
    `Default mode, ${mode}`,
  ].join("\n");
}

/**
 * "Make it mine" for instant templates (#362): sets the app name and brand
 * colour without a model run. Every instant template declares each one in a
 * single place (see `templates/README.md`), so this is a plain replacement.
 */

export const BRAND_FILE = "src/brand.ts";
export const BRAND_FILES = ["index.html", BRAND_FILE, "src/index.css"] as const;
export type BrandFiles = Record<(typeof BRAND_FILES)[number], string>;

/** Mid-tone colours that read with white text in light and dark mode. */
export const BRAND_COLORS = [
  { name: "Indigo", value: "oklch(0.511 0.262 276.966)" },
  { name: "Blue", value: "oklch(0.546 0.245 262.881)" },
  { name: "Teal", value: "oklch(0.6 0.118 184.704)" },
  { name: "Green", value: "oklch(0.627 0.194 149.214)" },
  { name: "Orange", value: "oklch(0.646 0.222 41.116)" },
  { name: "Rose", value: "oklch(0.586 0.253 17.585)" },
] as const;

const WHITE = "oklch(0.985 0 0)";
const TITLE = /<title>[^<]*<\/title>/;
const BRAND_NAME = /export const BRAND_NAME = "(?:[^"\\]|\\.)*";/;
const PRIMARY = /--primary: [^;]+;/g;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The brand files with the name and/or colour applied, both themes alike.
 * Null when a file lacks its marker, so nothing is half-applied.
 */
export const applyBrandOrNull = (
  files: BrandFiles,
  { name, color }: { name?: string; color?: string },
): BrandFiles | null => {
  const css = files["src/index.css"];
  if (!TITLE.test(files["index.html"]) || !BRAND_NAME.test(files[BRAND_FILE])) return null;
  if (!css.match(PRIMARY) || !css.includes("--ring: ")) return null;

  const trimmed = name?.trim();
  return {
    "index.html": trimmed
      ? files["index.html"].replace(TITLE, () => `<title>${escapeHtml(trimmed)}</title>`)
      : files["index.html"],
    [BRAND_FILE]: trimmed
      ? files[BRAND_FILE].replace(BRAND_NAME, () => `export const BRAND_NAME = ${JSON.stringify(trimmed)};`)
      : files[BRAND_FILE],
    "src/index.css": color
      ? css
          .replace(PRIMARY, `--primary: ${color};`)
          .replace(/--primary-foreground: [^;]+;/g, `--primary-foreground: ${WHITE};`)
          .replace(/--ring: [^;]+;/g, `--ring: ${color};`)
      : css,
  };
};

/** The one short run a description sends: copy only, layout untouched. */
export const rewriteCopyPrompt = (description: string) =>
  `Rewrite the copy of this app for ${description.trim()}. Keep the layout, components, brand name and colours as they are.`;

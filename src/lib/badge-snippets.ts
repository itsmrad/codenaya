const BADGES = {
  open: { alt: "Open in Codenaya", file: "open-in-codenaya.svg" },
  remix: { alt: "Remix on Codenaya", file: "remix-on-codenaya.svg" },
} as const;

/**
 * Markdown and HTML for a badge in `public/badges/` linking to `path` on
 * `origin`. Paths come from validated slugs and ids, so nothing needs escaping.
 */
export const badgeSnippets = (kind: keyof typeof BADGES, origin: string, path: string) => {
  const { alt, file } = BADGES[kind];
  const image = new URL(`/badges/${file}`, origin).href;
  const href = new URL(path, origin).href;
  return {
    markdown: `[![${alt}](${image})](${href})`,
    html: `<a href="${href}"><img src="${image}" alt="${alt}" height="28"></a>`,
  };
};

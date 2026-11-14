import type { BuiltinSkill } from "../types";

/**
 * Built-in skill: seo-and-share-cards (#303). Titles, descriptions, Open Graph
 * and Twitter card tags, robots.txt and a sitemap for Vite and Next.js apps.
 */
const body = `# SEO and share cards

Use this when asked to make an app "SEO-ready", to fix how shared links look, or before an app is published. The goal: every page has a real title and description, a shared link shows a proper card (title, description, 1200×630 image), and search engines get \`robots.txt\` and a sitemap.

## The site URL

\`og:url\`, \`og:image\` and sitemap entries must be absolute \`https://\` URLs, so they need the site's public origin. Use the one the user gave you. If you don't know it, never invent a domain: write everything else, leave out whatever needs the origin (those tags, \`metadataBase\`, the robots.txt \`Sitemap:\` line, sitemap.xml), and in Notes ask for the URL and list where it goes.

## Share image

Create \`public/og.png\`, 1200×630 px (1.91:1), under 1 MB: the app name and a one-line pitch on the brand background, large enough to read as a thumbnail. Reference it as \`<origin>/og.png\`. Add a favicon (\`public/favicon.svg\`) and link it.

## Vite + React

Link-preview crawlers (chat apps, social networks) generally don't run JavaScript, so the share card must be in the static \`index.html\`, not added at runtime. Set it once for the site:

\`\`\`html
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acme Notes – Notes that organize themselves</title>
  <meta name="description" content="One or two sentences, about 150 characters, saying what the app does and for whom." />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Acme Notes" />
  <meta property="og:title" content="Acme Notes – Notes that organize themselves" />
  <meta property="og:description" content="Same idea as the description, written for a share card." />
  <meta property="og:url" content="https://acme.example/" />
  <meta property="og:image" content="https://acme.example/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Acme Notes logo and tagline" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Acme Notes – Notes that organize themselves" />
  <meta name="twitter:description" content="Same idea as the description, written for a share card." />
  <meta name="twitter:image" content="https://acme.example/og.png" />
</head>
\`\`\`

(\`acme.example\` stands for the real origin; never ship it.) Don't add a \`<link rel="canonical">\` here: every route is served this same file, so a fixed canonical would point them all at the homepage. Edit the starter's \`index.html\` in place: change \`<head>\` and the \`lang\` attribute, keep the rest.

Per-route titles and descriptions: **replace** the site-wide ones from \`index.html\`, never add a second \`<title>\` or \`<meta name="description">\` (don't render those elements in components: two description tags conflict). One small hook, no library:

\`\`\`ts
// src/lib/use-page-meta.ts
import { useEffect } from "react";

/** Replaces the title and description from index.html for this page. */
export function usePageMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [title, description]);
}
\`\`\`

Call it at the top of every public page, e.g. \`usePageMeta("Pricing – Acme Notes", "Plans for individuals and teams. Start free, upgrade any time.")\`, so navigating never leaves the previous page's values. Search engines that run JavaScript pick these up; share cards still use the \`index.html\` tags (per-page cards for a Vite app need prerendering, which is out of scope).

### public/robots.txt

\`\`\`
User-agent: *
Allow: /

Sitemap: https://acme.example/sitemap.xml
\`\`\`

Add \`Disallow:\` lines only for private areas (e.g. \`/app/\`, \`/admin/\`).

### public/sitemap.xml

One \`<url>\` per public route in the router (skip login-only and dynamic per-user pages):

\`\`\`xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://acme.example/</loc><lastmod>2026-01-15</lastmod></url>
  <url><loc>https://acme.example/pricing</loc><lastmod>2026-01-15</lastmod></url>
</urlset>
\`\`\`

Use today's date for \`lastmod\`. Google ignores \`priority\` and \`changefreq\`; leave them out.

## Next.js (App Router)

Use the Metadata API, not hand-written \`<head>\` tags. Next.js renders these on the server, so crawlers see per-page cards. In \`src/app/layout.tsx\`:

\`\`\`tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://acme.example"),
  title: { default: "Acme Notes", template: "%s – Acme Notes" },
  description: "One or two sentences saying what the app does and for whom.",
  openGraph: { type: "website", siteName: "Acme Notes", url: "/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "Acme Notes logo and tagline" }] },
  twitter: { card: "summary_large_image" },
};
\`\`\`

and \`<html lang="en">\` in the same layout. Each page exports its own \`metadata\` (or \`generateMetadata\` for dynamic routes, never both) with \`title\`, \`description\` and \`openGraph: { url: "/pricing", images: OG_IMAGES }\`. Without its own \`openGraph\` a page inherits the layout's \`url: "/"\` and its card points at the homepage; and \`openGraph\` is replaced, not merged, so keep the image list in one exported \`OG_IMAGES\` constant and repeat it. A \`src/app/opengraph-image.png\` (1200×630) or \`opengraph-image.tsx\` also works for the image.

\`src/app/robots.ts\` and \`src/app/sitemap.ts\` instead of static files:

\`\`\`ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: "https://acme.example/sitemap.xml" };
}
\`\`\`

\`\`\`ts
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = "https://acme.example";
  return ["", "/pricing"].map((path) => ({ url: \`\${origin}\${path}\`, lastModified: new Date() }));
}
\`\`\`

## Page content

- Exactly one \`<h1>\` per page, then \`<h2>\`/\`<h3>\` in order; don't skip levels for styling.
- Every meaningful \`<img>\` has \`alt\` describing it; decorative images get \`alt=""\`.
- Use \`<header>\`, \`<nav>\`, \`<main>\`, \`<footer>\` and real \`<a href>\` links for navigation (react-router's \`<Link>\` renders one).
- Titles under about 60 characters, descriptions about 150–160, both unique per page.

## Checklist (run it, then report it in Notes)

1. \`<html lang>\` set; favicon linked.
2. Site-wide \`<title>\` and meta description in \`index.html\`; \`usePageMeta\` on every public page, and only one of each tag in \`<head>\`.
3. \`og:type\`, \`og:title\`, \`og:description\`, \`og:url\`, \`og:image\` (absolute, 1200×630) and \`twitter:card\` = \`summary_large_image\`.
4. \`robots.txt\` with the \`Sitemap:\` line; \`sitemap.xml\` lists every public route with absolute URLs.
5. One \`h1\` per page; \`alt\` on images.
6. If the origin was unknown, Notes asks for it and lists the tags and files to update.

Tell the user they can check the card in any Open Graph preview tool once the app has a public URL.
`;

export const seoAndShareCards: BuiltinSkill = {
  name: "seo-and-share-cards",
  description:
    "Page titles, meta descriptions, Open Graph and Twitter share cards, robots.txt and sitemap.xml for Vite and Next.js apps, plus a pre-publish SEO checklist. Use when asked to make an app SEO-ready, fix link previews, or prepare it for publishing.",
  body,
};

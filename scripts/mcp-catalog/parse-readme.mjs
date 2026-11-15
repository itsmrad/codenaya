/**
 * Pure parsing for the community MCP catalog generator. No I/O, so it is unit
 * tested against a fixture README (see parse-readme.test.ts).
 */

/** The list's legend icons, keyed without the U+FE0F variation selector. */
const LANGUAGE_ICONS = {
  "🐍": "python",
  "📇": "typescript",
  "🏎": "go",
  "🦀": "rust",
  "#⃣": "csharp",
  "☕": "java",
  "🌊": "cpp",
  "💎": "ruby",
};
const SCOPE_ICONS = { "☁": "cloud", "🏠": "local", "📟": "embedded" };
const OS_ICONS = { "🍎": "macos", "🪟": "windows", "🐧": "linux" };
const OFFICIAL_ICON = "🎖";

const SERVERS_HEADING = /^##\s+Server Implementations\s*$/;
const ENTRY_LINE = /^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(.*)$/;
const MAX_DESCRIPTION = 220;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const stripVariation = (value) => value.replace(/️/g, "");

/** Turn inline markdown into plain text and keep it short. */
export function cleanDescription(markdown) {
  const text = markdown
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** `### 🗄️ <a name="databases"></a>Databases` → `Databases`. */
export function cleanCategory(heading) {
  const text = heading
    .replace(/^#+\s*/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Read the legend icons at the start of an entry's tail. They sit between the
 * link (and its badge) and the description, so scanning stops at the first
 * grapheme that is neither whitespace nor a legend icon.
 */
export function readLegend(tail) {
  const legend = { official: false, languages: [], scopes: [], os: [] };
  let consumed = 0;
  for (const { segment, index } of segmenter.segment(tail)) {
    const icon = stripVariation(segment);
    if (/^\s+$/.test(segment)) { consumed = index + segment.length; continue; }
    if (icon === OFFICIAL_ICON) legend.official = true;
    else if (LANGUAGE_ICONS[icon]) legend.languages.push(LANGUAGE_ICONS[icon]);
    else if (SCOPE_ICONS[icon]) legend.scopes.push(SCOPE_ICONS[icon]);
    else if (OS_ICONS[icon]) legend.os.push(OS_ICONS[icon]);
    else break;
    consumed = index + segment.length;
  }
  return { legend, rest: tail.slice(consumed) };
}

/** `https://github.com/Owner/Repo/tree/main/x` → owner, repo, subpath. Null off GitHub. */
export function parseGithubUrl(url) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.*?))?\/?(?:[?#].*)?$/i.exec(url);
  if (!match) return null;
  const [, owner, repo, rest = ""] = match;
  // `tree/<branch>/<path>` and `blob/<branch>/<path>` point inside a monorepo.
  const subpath = /^(?:tree|blob)\/[^/]+\/(.+)$/.exec(rest)?.[1]?.replace(/\/$/, "") ?? "";
  return { owner, repo, key: `${owner}/${repo}`.toLowerCase(), subpath };
}

export const slugify = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Parse every entry under "## Server Implementations". Each `### ` heading is a
 * category; each top-level `- [name](url) …` line is an entry.
 */
export function parseReadme(markdown) {
  const entries = [];
  let inServers = false;
  let category;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inServers = SERVERS_HEADING.test(line); category = undefined; continue; }
    if (!inServers) continue;
    if (/^###\s/.test(line)) { category = cleanCategory(line); continue; }
    const match = category ? ENTRY_LINE.exec(line) : null;
    if (!match) continue;
    const [, linkText, url, tail] = match;
    // Drop badge images before reading the legend that follows them.
    const withoutBadges = tail.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    const { legend, rest } = readLegend(withoutBadges);
    entries.push({
      name: linkText.replace(/^@/, "").trim(),
      url,
      category,
      description: cleanDescription(rest.replace(/^\s*[-–—:]\s*/, "")),
      ...legend,
    });
  }
  return entries;
}

/** One term per line; blank lines and `#` comments ignored. */
export function parseExcludeTerms(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive matcher. Hyphens and slashes count as word breaks. */
export function termMatcher(terms) {
  if (!terms.length) return null;
  const alternatives = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "giu");
}

const REPLACEMENT = "MCP clients";

/**
 * Repo names glue words together (`acme-foo` is caught by word breaks, `acmefoo`
 * is not), so names and URLs are also checked for embedded terms. Only longer
 * terms, because a short one embeds in ordinary words.
 */
const MIN_EMBEDDED_TERM = 6;

/**
 * Drop entries whose name or URL names an excluded term, and neutralise the
 * term in descriptions. Returns the kept entries and how many were dropped.
 */
export function applyExclusions(entries, terms) {
  const matcher = termMatcher(terms);
  if (!matcher) return { kept: entries, dropped: 0 };
  const embedded = terms.filter((term) => term.length >= MIN_EMBEDDED_TERM).map((term) => term.toLowerCase());
  const hits = (value) => {
    matcher.lastIndex = 0;
    return matcher.test(value) || embedded.some((term) => value.toLowerCase().includes(term));
  };
  const kept = [];
  for (const entry of entries) {
    if (hits(entry.name) || hits(entry.url)) continue;
    matcher.lastIndex = 0;
    let description = entry.description.replace(matcher, REPLACEMENT);
    // "works with A, B and C" → "works with MCP clients", not three repeats.
    const repeated = new RegExp(`${REPLACEMENT}(?:\\s*(?:,|/|and|or|&)\\s*${REPLACEMENT})+`, "g");
    description = description.replace(repeated, REPLACEMENT);
    kept.push({ ...entry, description });
  }
  return { kept, dropped: entries.length - kept.length };
}

/** Shared hosting cannot establish that a repo publisher owns a remote. */
const HOSTING_DOMAINS = [
  "smithery.ai", "glama.ai", "run.app", "fly.dev", "herokuapp.com", "railway.app",
  "ngrok-free.app", "ngrok.io", "ngrok.app", "vercel.app", "netlify.app", "pages.dev",
  "workers.dev", "onrender.com", "azurewebsites.net", "cloudfront.net", "appspot.com",
  "github.io", "glitch.me", "replit.app", "repl.co", "deno.dev", "koyeb.app", "up.railway.app",
];
// Fail closed for unrecognised/multi-label suffixes; no guessed eTLD+1 parsing.
const OWNER_DOMAIN_SUFFIXES = new Set(["com", "org", "net", "io", "dev", "app", "ai", "tech", "cloud", "tools", "software"]);

/** Domain vouches require an exact owner-named domain, not a proxy's namespace. */
export function publisherVouches(serverName, repo, remoteUrl) {
  const namespace = serverName.toLowerCase().split("/")[0];
  const host = new URL(remoteUrl).hostname.toLowerCase();
  if (HOSTING_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
  if (namespace === `io.github.${repo.owner.toLowerCase()}`) return "owner";
  const domain = namespace.split(".").reverse().join(".");
  const labels = domain.split(".");
  return labels.length === 2 && labels[0] === repo.owner.toLowerCase()
    && OWNER_DOMAIN_SUFFIXES.has(labels[1])
    && (host === domain || host.endsWith(`.${domain}`)) ? "domain" : null;
}

/** Read literal trusted-host arrays from the vetted catalog without importing app code. */
export function readTrustedHostnames(source) {
  const arrays = [...source.matchAll(/trustedHostnames:\s*\[([^\]]*)\]/g)];
  if (!arrays.length) throw new Error("No trustedHostnames found in vetted catalog");
  return new Set(arrays.flatMap((match) => {
    const values = [...match[1].matchAll(/"([^"\n]+)"/g)].map((value) => value[1].toLowerCase());
    if (!values.length || match[1].replace(/"[^"\n]+"|[,\s]/g, "")) {
      throw new Error("Expected literal trustedHostnames in vetted catalog");
    }
    return values;
  }));
}

export function isVettedRemote(remoteUrl, trustedHostnames) {
  return !!remoteUrl && trustedHostnames.has(new URL(remoteUrl).hostname.toLowerCase());
}


/** Keep bypass tooling out of the catalog, including renamed repos. */
export function applyContentPolicy(entries) {
  const bypass = /captcha|anti[\s-]?bot|bot[\s-]+detection[\s-]+bypass|stealth|undetected/i;
  const kept = entries.filter((entry) => !bypass.test(`${entry.name} ${entry.description}`));
  return { kept, dropped: entries.length - kept.length };
}

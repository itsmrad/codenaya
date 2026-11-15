#!/usr/bin/env node
/**
 * Build src/features/integrations/community-catalog.json from the public
 * awesome-mcp-servers list (MIT), GitHub stars and the official MCP registry.
 *
 *   node scripts/mcp-catalog/build.mjs --exclude-file <path> [--limit 500]
 *     [--readme <local README.md>] [--cache-hours 24] [--probe-oauth]
 *
 * Needs an authenticated `gh` CLI for stars. Network responses are cached under
 * scripts/mcp-catalog/.cache (gitignored), so a re-run within --cache-hours is
 * offline apart from what changed. See docs/INTEGRATIONS.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  applyExclusions,
  parseExcludeTerms,
  parseGithubUrl,
  parseReadme,
  publisherVouches,
  slugify,
  termMatcher,
} from "./parse-readme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(HERE, ".cache");
const OUTPUT = resolve(HERE, "../../src/features/integrations/community-catalog.json");
const LIST_REPO = "punkpeye/awesome-mcp-servers";
const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const STAR_BATCH = 100;
const PACE_MS = 1_000;
const REGISTRY_PACE_MS = 250;
const USER_AGENT = "codenaya-mcp-catalog";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readCache(name, maxAgeMs) {
  const path = resolve(CACHE_DIR, name);
  if (!existsSync(path)) return undefined;
  const cached = JSON.parse(readFileSync(path, "utf8"));
  return Date.now() - cached.fetchedAt <= maxAgeMs ? cached : undefined;
}

function writeCache(name, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(resolve(CACHE_DIR, name), JSON.stringify(value));
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function fetchReadme() {
  const result = gh(["api", `repos/${LIST_REPO}/contents/README.md`, "-H", "Accept: application/vnd.github.raw"]);
  if (result.status !== 0) throw new Error(`Could not download the list README: ${result.stderr}`);
  return result.stdout;
}

/**
 * Stars for every repo key, about 100 aliased lookups per GraphQL query. A
 * missing repo comes back as null with a NOT_FOUND error, which `gh` reports
 * with a non-zero exit while still printing the partial data.
 */
async function fetchStars(keys, maxAgeMs) {
  const cache = readCache("stars.json", maxAgeMs) ?? { fetchedAt: Date.now(), repos: {} };
  const todo = keys.filter((key) => !(key in cache.repos));
  for (let start = 0; start < todo.length; start += STAR_BATCH) {
    const batch = todo.slice(start, start + STAR_BATCH);
    const fields = batch.map((key, index) => {
      const [owner, name] = key.split("/");
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner stargazerCount isArchived isDisabled }`;
    });
    const result = gh(["api", "graphql", "-f", `query=query { ${fields.join("\n")} }`]);
    let body;
    try { body = JSON.parse(result.stdout); } catch { throw new Error(`GitHub GraphQL failed: ${result.stderr}`); }
    if (!body.data) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`);
    batch.forEach((key, index) => {
      const repo = body.data[`r${index}`];
      cache.repos[key] = repo
        ? { stars: repo.stargazerCount, dead: repo.isArchived || repo.isDisabled, nameWithOwner: repo.nameWithOwner }
        : { stars: 0, dead: true, missing: true };
    });
    writeCache("stars.json", cache);
    console.error(`stars: ${Math.min(start + STAR_BATCH, todo.length)}/${todo.length}`);
    if (start + STAR_BATCH < todo.length) await sleep(PACE_MS);
  }
  return cache;
}

/** Every latest, active server in the official registry, page by page. */
async function fetchRegistry(maxAgeMs) {
  const cached = readCache("registry.json", maxAgeMs);
  if (cached) return cached.servers;
  const servers = [];
  let pageToken;
  do {
    const url = new URL(REGISTRY);
    url.searchParams.set("limit", "100");
    url.searchParams.set("version", "latest");
    if (pageToken) url.searchParams.set("cursor", pageToken);
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Registry returned ${response.status} for ${url}`);
    const page = await response.json();
    for (const item of page.servers ?? []) {
      const server = item.server ?? item;
      const status = item._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active";
      if (status !== "active" || !server.repository?.url || !server.remotes?.length) continue;
      servers.push({ name: server.name, repository: server.repository, remotes: server.remotes });
    }
    pageToken = page.metadata?.nextCursor;
    console.error(`registry: ${servers.length} servers with remotes`);
    if (pageToken) await sleep(REGISTRY_PACE_MS);
  } while (pageToken);
  writeCache("registry.json", { fetchedAt: Date.now(), servers });
  return servers;
}

const TRANSPORTS = { "streamable-http": "http", sse: "sse" };

/** A usable remote: a concrete https URL (no `{template}` variables) of a known type. */
const usableRemote = (remote) => {
  if (!TRANSPORTS[remote.type] || typeof remote.url !== "string" || /[{}]/.test(remote.url)) return false;
  try { return new URL(remote.url).protocol === "https:"; } catch { return false; }
};

/** Registry servers indexed by GitHub repo key; the repo owner's own entry first. */
function indexRegistry(servers) {
  const byRepo = new Map();
  for (const server of servers) {
    const repo = parseGithubUrl(server.repository.url);
    const remote = server.remotes.filter(usableRemote).sort((a, b) => (a.type === "sse") - (b.type === "sse"))[0];
    if (!repo || !remote) continue;
    const vouch = publisherVouches(server.name, repo, remote.url);
    if (!vouch) continue;
    const candidate = {
      name: server.name,
      subfolder: (server.repository.subfolder ?? "").replace(/^\/|\/$/g, ""),
      verified: vouch === "owner",
      remote,
    };
    byRepo.set(repo.key, [...(byRepo.get(repo.key) ?? []), candidate]);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
  }
  return byRepo;
}

function matchRemote(byRepo, repo) {
  const candidates = byRepo.get(repo.key) ?? [];
  // A monorepo subfolder entry only takes a remote registered for that folder.
  return repo.subpath
    ? candidates.find((candidate) => candidate.subfolder === repo.subpath)
    : candidates.find((candidate) => !candidate.subfolder) ?? candidates[0];
}

/**
 * Optional, opt-in: does a remote publish RFC 9728 protected-resource
 * metadata? One unauthenticated GET per remote, paced and cached. Only run for
 * the remote-capable entries that made the cut, never the whole list.
 */
async function probeOAuth(urls, maxAgeMs) {
  const cache = readCache("oauth.json", maxAgeMs) ?? { fetchedAt: Date.now(), results: {} };
  for (const url of urls.filter((value) => !(value in cache.results))) {
    const target = new URL(url);
    const wellKnown = new URL(`/.well-known/oauth-protected-resource${target.pathname === "/" ? "" : target.pathname}`, target.origin);
    let oauth = false;
    try {
      const response = await fetch(wellKnown, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        oauth = Array.isArray(body?.authorization_servers) && body.authorization_servers.length > 0;
      }
    } catch { /* Unreachable or not JSON: leave auth unknown. */ }
    cache.results[url] = oauth;
    writeCache("oauth.json", cache);
    await sleep(PACE_MS);
  }
  return cache.results;
}

/** Unique, stable slug: owner-repo, plus the monorepo folder when there is one. */
function makeId(repo, used) {
  const base = slugify(`${repo.owner}-${repo.repo}${repo.subpath ? `-${repo.subpath.split("/").pop()}` : ""}`);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "exclude-file": { type: "string" },
      limit: { type: "string", default: "500" },
      readme: { type: "string" },
      "cache-hours": { type: "string", default: "24" },
      "probe-oauth": { type: "boolean", default: false },
      output: { type: "string", default: OUTPUT },
    },
  });
  if (!values["exclude-file"]) throw new Error("--exclude-file <path> is required (the term list is never committed).");
  const terms = parseExcludeTerms(readFileSync(values["exclude-file"], "utf8"));
  const limit = Number(values.limit);
  const maxAgeMs = Number(values["cache-hours"]) * 3_600_000;
  const starsAsOf = new Date().toISOString().slice(0, 10);

  const parsed = parseReadme(values.readme ? readFileSync(values.readme, "utf8") : fetchReadme());
  const stats = { parsed: parsed.length, nonGithub: 0, duplicate: 0, excluded: 0, dead: 0, missing: 0 };

  const seen = new Set();
  const githubEntries = [];
  for (const entry of parsed) {
    const repo = parseGithubUrl(entry.url);
    if (!repo) { stats.nonGithub++; continue; }
    const dedupeKey = `${repo.key}/${repo.subpath.toLowerCase()}`;
    if (seen.has(dedupeKey)) { stats.duplicate++; continue; }
    seen.add(dedupeKey);
    githubEntries.push({ ...entry, repo });
  }

  const { kept, dropped } = applyExclusions(githubEntries, terms);
  stats.excluded = dropped;

  const stars = await fetchStars([...new Set(kept.map((entry) => entry.repo.key))], maxAgeMs);
  const canonical = new Set();
  const alive = kept.filter((entry) => {
    const info = stars.repos[entry.repo.key];
    if (info.missing) stats.missing++;
    else if (info.dead) stats.dead++;
    if (info.dead) return false;
    // Two list URLs can name one repo under its old and new names.
    const key = `${info.nameWithOwner.toLowerCase()}/${entry.repo.subpath.toLowerCase()}`;
    if (canonical.has(key)) { stats.duplicate++; return false; }
    canonical.add(key);
    return true;
  });

  const byRepo = indexRegistry(await fetchRegistry(maxAgeMs));
  const used = new Set();
  const ranked = alive
    .map((entry) => ({ entry, stars: stars.repos[entry.repo.key].stars }))
    .sort((a, b) => b.stars - a.stars || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(({ entry, stars: count }) => {
      const renamed = { ...entry.repo, key: stars.repos[entry.repo.key].nameWithOwner.toLowerCase() };
      const match = matchRemote(byRepo, renamed) ?? matchRemote(byRepo, entry.repo);
      const headers = match?.remote.headers ?? [];
      return {
        id: makeId(entry.repo, used),
        name: entry.name,
        repoUrl: `https://github.com/${entry.repo.owner}/${entry.repo.repo}${entry.repo.subpath ? `/tree/HEAD/${entry.repo.subpath}` : ""}`,
        description: entry.description,
        category: entry.category,
        language: entry.languages[0] ?? null,
        stars: count,
        starsAsOf,
        official: entry.official,
        transport: match ? TRANSPORTS[match.remote.type] : "stdio",
        ...(match ? { remoteUrl: match.remote.url } : {}),
        auth: headers.length ? "api-key" : "unknown",
      };
    });

  if (values["probe-oauth"]) {
    const oauth = await probeOAuth(ranked.filter((e) => e.remoteUrl && e.auth === "unknown").map((e) => e.remoteUrl), maxAgeMs);
    for (const entry of ranked) if (entry.remoteUrl && oauth[entry.remoteUrl]) entry.auth = "oauth";
  }

  ranked.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));

  // Last line of defence: no excluded term may survive anywhere in the output.
  const matcher = termMatcher(terms);
  const leaked = matcher ? ranked.filter((entry) => { matcher.lastIndex = 0; return matcher.test(JSON.stringify(entry)); }) : [];
  if (leaked.length) throw new Error(`${leaked.length} entries still contain an excluded term: ${leaked.map((e) => e.id).join(", ")}`);

  writeFileSync(values.output, `[\n${ranked.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`);
  const remote = ranked.filter((entry) => entry.transport !== "stdio").length;
  console.log(JSON.stringify({
    ...stats,
    written: ranked.length,
    remoteCapable: remote,
    stdioOnly: ranked.length - remote,
    auth: Object.fromEntries(["oauth", "api-key", "unknown"].map((auth) => [auth, ranked.filter((e) => e.remoteUrl && e.auth === auth).length])),
    starsAsOf,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

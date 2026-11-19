import type { ProjectFile } from "@/features/sandbox-preview/server/project-sandbox";
import type { Sandbox } from "@/features/sandbox-preview/server/provider/types";

/**
 * Remote images in a generated site that do not load. Models often invent
 * stock-photo URLs (an Unsplash photo id that does not exist answers 404), so
 * checkBuild probes each remote image once from the sandbox and appends the
 * dead ones to a passing result as a warning for the agent to replace. A
 * warning never fails the check, and only definite failures count: timeouts,
 * 5xx and refusals are ignored, so network flakiness cannot add one.
 */

/** Files a page's images come from. */
const SOURCE_FILE = /^(?:index\.html|(?:src|public)\/.+\.(?:html|[cm]?[jt]sx?|css|scss|mdx?|json))$/;
const URL_PATTERN = /https?:\/\/[^\s"'`<>()\\]+/g;
const IMAGE_PATH = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;
/** A URL cut where code joins on more (`"…/photo-" + id`, `"?w=" + width`), so not the one requested. */
const PARTIAL_URL = /[/\-=?&]$/;
/** What a 2xx soft-404 page is served as; any other type (octet-stream, none) may still be an image. */
const PAGE_TYPE = /^(?:text\/|application\/(?:json|xml)\b)/i;
/** Hosts that serve only images, whatever the path. */
const IMAGE_HOSTS = new Set([
  "images.unsplash.com",
  "plus.unsplash.com",
  "source.unsplash.com",
  "images.pexels.com",
  "picsum.photos",
  "fastly.picsum.photos",
  "i.pravatar.cc",
]);
/** Shut down: every URL there fails, so it is not probed. */
const DEAD_HOSTS = new Set(["source.unsplash.com"]);

/** Bounds: the URLs probed per check, parallel requests, and each request's and the whole probe's time. */
export const MAX_IMAGE_URLS = 30;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 4_000;
const PROBE_BUDGET_MS = 12_000;
/** The command's own limit: the budget plus a last HEAD and GET, and node's start. */
const IMAGE_CHECK_TIMEOUT_MS = PROBE_BUDGET_MS + 2 * REQUEST_TIMEOUT_MS + 5_000;

/** The remote image URLs in the project's page sources, each with every file that uses it. */
export const remoteImageUrls = (files: ProjectFile[]) => {
  const urls = new Map<string, Set<string>>();
  for (const { path, content } of files) {
    if (!SOURCE_FILE.test(path)) continue;
    for (const match of content.matchAll(URL_PATTERN)) {
      const url = match[0].replace(/[.,;:]+$/, "");
      urls.get(url)?.add(path);
      // A template literal's URL is only known at runtime.
      if (url.includes("${") || PARTIAL_URL.test(url) || urls.has(url) || urls.size >= MAX_IMAGE_URLS) continue;
      try {
        const { hostname, pathname } = new URL(url);
        // A bare host (preconnect, a base URL constant) is not an image.
        if (pathname === "/") continue;
        if (IMAGE_HOSTS.has(hostname) || IMAGE_PATH.test(pathname)) urls.set(url, new Set([path]));
      } catch {
        // Not a URL after all.
      }
    }
  }
  return urls;
};

/**
 * Runs in the sandbox's node: HEAD each URL, then a one-byte GET when HEAD is
 * not an image (some hosts refuse HEAD), with bounded concurrency, a timeout per
 * request and a budget for the whole probe. Resolves to [url, status, content type];
 * status 0 is a request that failed or was not made. Plain JS, exported for tests.
 */
export const PROBE_SOURCE = `async (urls) => {
  const stopAt = Date.now() + ${PROBE_BUDGET_MS};
  const request = (url, init) => fetch(url, { redirect: "follow", headers: { accept: "image/*", ...init.headers },
    method: init.method, signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}) });
  const isImage = (res) => res.ok && /^image\\//i.test(res.headers.get("content-type") || "");
  const probe = async (url) => {
    try {
      let res = await request(url, { method: "HEAD" });
      if (!isImage(res)) res = await request(url, { method: "GET", headers: { range: "bytes=0-0" } });
      await res.body?.cancel().catch(() => {});
      return [url, res.status, res.headers.get("content-type") || ""];
    } catch {
      return [url, 0, ""];
    }
  };
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: ${CONCURRENCY} }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      results.push(Date.now() < stopAt ? await probe(url) : [url, 0, ""]);
    }
  }));
  return results;
}`;

type ProbeResult = [url: string, status: number, contentType: string];

/** Why a probed URL is a broken image, or undefined when it loads or the probe was inconclusive. */
export const brokenReason = ([, status, contentType]: ProbeResult) => {
  if (status === 404 || status === 410) return `HTTP ${status}`;
  if (status >= 200 && status < 300 && PAGE_TYPE.test(contentType)) return `not an image (${contentType})`;
  return undefined;
};

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The broken remote images among `urls`, probed from `sandbox`, as
 * "file: url (reason)" lines, one per file that uses each. Never throws: a
 * probe that fails or times out reports nothing.
 */
export const brokenRemoteImages = async (sandbox: Sandbox, urls: Map<string, Set<string>>, timeoutMs: number) => {
  const broken: string[] = [];
  const report = (url: string, reason: string) => {
    for (const path of urls.get(url) ?? []) broken.push(`${path}: ${url} (${reason})`);
  };
  const probed: string[] = [];
  for (const url of urls.keys()) {
    if (DEAD_HOSTS.has(new URL(url).hostname)) report(url, "the host is shut down");
    else probed.push(url);
  }
  if (probed.length > 0) {
    try {
      const script = `(${PROBE_SOURCE})(${JSON.stringify(probed)}).then((r) => console.log(JSON.stringify(r)))`;
      const limit = Math.min(timeoutMs, IMAGE_CHECK_TIMEOUT_MS);
      const { stdout } = await sandbox.run(`node -e ${shellQuote(script)}`, { timeoutMs: limit, requestTimeoutMs: limit });
      for (const result of JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as ProbeResult[]) {
        const reason = brokenReason(result);
        if (reason) report(result[0], reason);
      }
    } catch (error) {
      console.error("[check-build] image check skipped", error instanceof Error ? error.message : error);
    }
  }
  return broken;
};

/** Appended to a passing checkBuild result: the agent fixes these, but they never fail the build. */
export const brokenImagesWarning = (broken: string[]) =>
  "\nWarning: broken remote images (they do not load, so the page shows broken images). " +
  "Replace each URL in these files with an image URL you know exists, or https://picsum.photos/seed/<word>/<width>/<height>:\n- " +
  broken.join("\n- ");

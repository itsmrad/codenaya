/**
 * Where an imported skill's SKILL.md lives on GitHub, and how to fetch it.
 *
 * Only `raw.githubusercontent.com` is ever requested: the host is fixed here
 * and the user's URL only supplies owner, repo, ref and path segments, so an
 * import cannot be pointed at any other server (no SSRF).
 */

export const SKILL_MD_MAX_BYTES = 64 * 1024;
export const SKILL_FETCH_TIMEOUT_MS = 10_000;

const RAW_HOST = "https://raw.githubusercontent.com";

export interface GitHubSkillSource {
  owner: string;
  repo: string;
  /** Branch, tag or commit; `HEAD` is the default branch. */
  ref: string;
  /**
   * Folders that may hold SKILL.md, tried in order. A skills.sh page only
   * names the skill, so it maps to the common repo layouts.
   */
  paths: string[];
}

export class SkillImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SkillImportError";
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Path and ref segments: no "." / ".." and nothing that would change the URL.
const SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._@+-]{1,100}$/;

export const INVALID_SOURCE_MESSAGE =
  "Paste a GitHub folder URL (github.com/owner/repo/tree/main/path), owner/repo/path, or a skills.sh skill page";

const invalid = () => new SkillImportError(INVALID_SOURCE_MESSAGE, 400);

const buildSource = (
  [owner, repo]: string[],
  ref: string,
  pathOptions: string[][],
): GitHubSkillSource => {
  if (!owner || !repo || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    throw invalid();
  }
  const segments = [ref, ...pathOptions.flat()];
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
    throw invalid();
  }
  return {
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref,
    paths: pathOptions.map((path) => path.join("/")),
  };
};

/** Drops a trailing SKILL.md so blob and folder URLs resolve the same way. */
const withoutSkillMd = (segments: string[]) =>
  segments.at(-1)?.toLowerCase() === "skill.md" ? segments.slice(0, -1) : segments;

/**
 * Parses what the user pasted into a GitHub location. Accepts
 * `https://github.com/o/r[/tree|blob/<ref>/<path>]`, raw.githubusercontent.com
 * URLs, `o/r/<path>` and `https://skills.sh/o/r/<skill>`. Throws a
 * `SkillImportError` (400) for anything else.
 */
export function parseSkillSource(input: string): GitHubSkillSource {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) throw invalid();

  // Shorthand: owner/repo/path, with no scheme or host. Owners never contain
  // a dot, so a dotted first segment is a host typed without https://.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (!hasScheme && !trimmed.split("/")[0].includes(".")) {
    const segments = withoutSkillMd(trimmed.split("/").filter(Boolean));
    return buildSource(segments, "HEAD", [segments.slice(2)]);
  }

  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid();

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw invalid();
      }
    });
  const host = url.hostname.toLowerCase();

  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ref, ...rest] = segments;
    if (kind === undefined) return buildSource([owner, repo], "HEAD", [[]]);
    if ((kind !== "tree" && kind !== "blob") || !ref) throw invalid();
    return buildSource([owner, repo], ref, [withoutSkillMd(rest)]);
  }

  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...rest] = segments;
    if (!ref) throw invalid();
    return buildSource([owner, repo], ref, [withoutSkillMd(rest)]);
  }

  if (host === "skills.sh" || host === "www.skills.sh") {
    const [owner, repo, skill, ...rest] = segments;
    if (!skill || rest.length > 0) throw invalid();
    return buildSource([owner, repo], "HEAD", [
      ["skills", skill],
      [skill],
      // Single-skill repos keep SKILL.md at the root.
      ...(skill === repo ? [[]] : []),
    ]);
  }

  throw new SkillImportError(
    "Only GitHub and skills.sh links can be imported",
    400,
  );
}

const encodePath = (path: string) =>
  path.split("/").filter(Boolean).map(encodeURIComponent);

/** The raw.githubusercontent.com URL of SKILL.md in one candidate folder. */
export const rawSkillMdUrl = (source: GitHubSkillSource, path: string) =>
  [
    RAW_HOST,
    encodeURIComponent(source.owner),
    encodeURIComponent(source.repo),
    encodeURIComponent(source.ref),
    ...encodePath(path),
    "SKILL.md",
  ].join("/");

/** The github.com page for a skill folder, stored as the skill's source. */
export const githubFolderUrl = (source: GitHubSkillSource, path: string) =>
  [
    "https://github.com",
    encodeURIComponent(source.owner),
    encodeURIComponent(source.repo),
    "tree",
    encodeURIComponent(source.ref),
    ...encodePath(path),
  ].join("/");

/** Reads at most `SKILL_MD_MAX_BYTES`, failing as soon as the cap is passed. */
async function readCapped(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > SKILL_MD_MAX_BYTES) {
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SKILL_MD_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const tooLarge = () =>
  new SkillImportError(
    `SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB`,
    413,
  );

export interface FetchedSkillMd {
  text: string;
  /** The folder SKILL.md was found in, relative to the repo root. */
  path: string;
}

/**
 * Fetches SKILL.md from the first candidate folder that has one. Redirects
 * are refused so the request cannot leave raw.githubusercontent.com.
 */
export async function fetchSkillMd(
  source: GitHubSkillSource,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedSkillMd> {
  for (const path of source.paths) {
    let response: Response;
    try {
      response = await fetchImpl(rawSkillMdUrl(source, path), {
        redirect: "error",
        signal: AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS),
        headers: { Accept: "text/plain" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SkillImportError("GitHub took too long to respond", 504);
      }
      throw new SkillImportError("Could not reach GitHub", 502);
    }

    if (response.status === 404) continue;
    if (!response.ok) {
      throw new SkillImportError(
        `GitHub returned ${response.status} for SKILL.md`,
        502,
      );
    }
    return { text: await readCapped(response), path };
  }

  throw new SkillImportError(
    "No SKILL.md found there. Check the repository, branch and folder.",
    404,
  );
}

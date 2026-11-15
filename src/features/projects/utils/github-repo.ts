const GITHUB_URL_PREFIX = "https://github.com/";
// GitHub's own limits: owners are letters, digits and hyphens (max 39), repos
// add dots and underscores (max 100). "." and ".." are not repo names.
const REPO_SLUG = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Normalises `owner/repo` or a github.com URL to `owner/repo`, or returns
 * null. URLs may point inside the repo (`/tree/<ref>`, `/blob/...`) or carry
 * a trailing `/`, `.git`, `?query` or `#hash`; only owner and repo are kept
 * (the ref is ignored for now). Strict on the result: it is sent to the
 * GitHub API and put into URLs.
 */
export const parseGithubRepo = (input: string): string | null => {
  let path = input.trim();
  // Any scheme (https, ssh, git): only the host and path matter.
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      return null;
    }
    // Non-http schemes (ssh://) don't lowercase the host, so compare loosely.
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    path = url.pathname;
  }
  const [owner, repo = ""] = path.replace(/^\//, "").split("/");
  const slug = `${owner}/${repo.replace(/\.git$/, "")}`;
  return REPO_SLUG.test(slug) ? slug : null;
};

/** The GitHub URL of a repo slug from `parseGithubRepo`. */
export const githubRepoUrl = (slug: string) => `${GITHUB_URL_PREFIX}${slug}`;

/** The "Open in Codenaya" deep link for a repo slug from `parseGithubRepo`. */
export const importPath = (slug: string) => `/import?repo=${slug}`;

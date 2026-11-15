import { GITHUB_REPO_URL } from "@/lib/site";

/** Optional public proof: never authenticate or block the landing page on GitHub. */
export const getGithubStars = async (): Promise<number | null> => {
  try {
    const response = await fetch(
      GITHUB_REPO_URL.replace("https://github.com/", "https://api.github.com/repos/"),
      { next: { revalidate: 3600 }, signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.private === false && Number.isSafeInteger(data.stargazers_count) && data.stargazers_count >= 0
      ? data.stargazers_count
      : null;
  } catch {
    // Stars are best-effort; timeouts, network errors and invalid JSON hide only the count.
    return null;
  }
};

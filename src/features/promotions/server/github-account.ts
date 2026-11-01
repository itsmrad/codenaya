/** The fields of GitHub's `GET /user` the promotion checks. */
export interface GithubAccount {
  id: number;
  login: string;
  /** Epoch ms. */
  createdAt: number;
}

/**
 * The account behind a GitHub OAuth token, read from GitHub itself so the
 * creation date can't come from the client. Null when GitHub refuses the
 * token (revoked or expired); throws on anything else, which the route
 * reports as a failure to retry.
 */
export async function fetchGithubAccount(token: string): Promise<GithubAccount | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`GitHub /user returned ${res.status}`);
  }

  const data: { id?: unknown; login?: unknown; created_at?: unknown } = await res.json();
  const createdAt = typeof data.created_at === "string" ? Date.parse(data.created_at) : NaN;
  if (typeof data.id !== "number" || typeof data.login !== "string" || Number.isNaN(createdAt)) {
    throw new Error("GitHub /user returned an unexpected body");
  }
  return { id: data.id, login: data.login, createdAt };
}

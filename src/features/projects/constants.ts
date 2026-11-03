/** Error code returned by the GitHub import/export routes when the signed-in
 * user has no GitHub account linked in Clerk (no OAuth token to clone/push). */
export const GITHUB_NOT_LINKED = "GITHUB_NOT_LINKED";

/** Where a GitHub push goes when the linked branch moved outside Codenaya (#343). */
export const GITHUB_SYNC_BRANCH = "codenaya-sync";

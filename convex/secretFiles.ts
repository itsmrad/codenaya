/** Example files meant to be committed and shared (the convention `security/scan-project.ts` also uses). */
const SHAREABLE_ENV_FILE = /^\.env\.(?:example|sample)$/;

/**
 * File names that usually hold credentials. GitHub imports keep whatever was
 * committed, so these must not reach anyone but the owner.
 */
const SECRET_FILE_PATTERNS = [
  /^\.env(?:rc)?$/, // .env; direnv's .envrc exports secrets too
  /^\.env\./, // .env.local, .env.production, ...
  /\.env$/, // prod.env
  /\.(?:pem|key|p12|pfx|jks|keystore)$/, // certificates, private keys and keystores
  /^id_(?:rsa|ed25519|ecdsa|dsa)/, // SSH keys; the .pub halves too, nobody needs them from a share
  /^\.(?:npmrc|pypirc|netrc|git-credentials|pgpass)$/, // registry, git and database login tokens
  /^credentials.*\.json$/, // cloud CLI credentials
  /^credentials$/, // ~/.aws/credentials: matching is by name only, so the .aws folder isn't visible
  /service-account.*\.json$/, // cloud service-account keys
];

/**
 * Whether a file, by name only (so at any depth, case-insensitive), likely
 * holds secrets. Share links hide these and copies into someone else's
 * workspace (Remix, showcase import) skip them (#260).
 */
export const isSecretFile = (name: string) => {
  const lower = name.toLowerCase();
  return !SHAREABLE_ENV_FILE.test(lower) && SECRET_FILE_PATTERNS.some((pattern) => pattern.test(lower));
};

/**
 * Whether a project path names a secret file (by its last segment), however
 * it is spelled: `\` separators, `./` or empty segments, case, and the
 * trailing dots and spaces Windows ignores. The agent may see such a file's
 * name, never its content.
 */
export const isSecretPath = (path: string) => {
  const name = path.split(/[\\/]/).filter((segment) => segment && segment !== ".").pop() ?? "";
  return isSecretFile(name.trim().replace(/[. ]+$/, ""));
};

/** What the agent gets instead of a secret file's content: never the content itself. */
export const SECRET_FILE_REFUSAL =
  "This file holds environment values and is managed in the Environment Variables panel.";

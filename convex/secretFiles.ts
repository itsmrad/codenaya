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

/**
 * Environment-variable key classification and masking.
 *
 * Shared deliberately between the Convex mutation that accepts public values
 * from the browser and the API route that seals secret values. If these rules
 * lived in two places they would eventually disagree, and the failure mode of
 * that disagreement is a secret accepted as public — which is exactly the bug
 * this whole boundary exists to prevent.
 *
 * Everything here is pure and isomorphic: no Node APIs, so it is safe to import
 * from the Convex runtime.
 */

/**
 * Prefixes that frameworks inline into the client bundle at build time.
 *
 * A variable with one of these prefixes is public whether we like it or not —
 * the bundler embeds it in JavaScript served to the browser. Treating it as a
 * secret would be a false promise, so these are forced to `public` and the UI
 * explains why.
 */
export const PUBLIC_KEY_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "NUXT_PUBLIC_",
] as const;

/** POSIX-ish environment variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvVarVisibility = "public" | "secret";

export function isPublicByConvention(key: string): boolean {
  return PUBLIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export function assertValidEnvKey(key: string): void {
  if (!isValidEnvKey(key)) {
    throw new Error(
      `"${key}" is not a valid environment variable name. Use letters, digits and ` +
        `underscores, starting with a letter or underscore.`,
    );
  }
}

/**
 * Default visibility for a key.
 *
 * Defaults to `secret` for anything unrecognised. Erring toward secret means an
 * unfamiliar key is withheld from the browser preview — inconvenient but safe —
 * whereas erring toward public would publish it.
 */
export function classifyEnvKey(key: string): EnvVarVisibility {
  return isPublicByConvention(key) ? "public" : "secret";
}

/**
 * Preview shown in the UI for a secret value.
 *
 * Values of 8 characters or fewer are fully hidden: revealing the last four of a
 * six-character token would expose most of it. Longer values show a trailing
 * fragment, enough to tell two keys apart without being enough to use one.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `••••${value.slice(-4)}`;
}

/**
 * Preview for a credential such as an API key or access token.
 *
 * Keeps a recognisable prefix (`sbp_`, `rk_live_`, `github_pat_`) because that is
 * how a user identifies which credential a row holds, then masks the body. Falls
 * back to `maskSecret` when there is no prefix to preserve.
 */
export function maskCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "••••••••";

  const underscore = trimmed.lastIndexOf("_");
  // Only treat a leading segment as a prefix if it is short enough to be one and
  // leaves enough tail to still be masked meaningfully.
  if (underscore > 0 && underscore <= 12 && trimmed.length - underscore > 5) {
    return `${trimmed.slice(0, underscore + 1)}••••${trimmed.slice(-4)}`;
  }

  return maskSecret(trimmed);
}

/**
 * Why a cloud sandbox failed to start, so the preview can say what to do next.
 *
 * - `config`: the server can't reach E2B at all (missing or rejected API key).
 *   Retrying won't help until someone fixes the deployment.
 * - `rate_limit`: E2B refused because of plan or concurrency limits. Retrying
 *   later, or using the in-browser preview, will work.
 * - `transient`: anything else (network, install or dev-server failures).
 */
export type SandboxErrorKind = "config" | "rate_limit" | "transient";

const KINDS: readonly SandboxErrorKind[] = ["config", "rate_limit", "transient"];

/**
 * Classifies a failure from `/api/sandbox`. Prefers the explicit `code` the
 * route sends and falls back to the HTTP status for responses that carry none.
 */
export const classifySandboxError = ({
  code,
  status,
}: {
  code?: unknown;
  status?: number;
}): SandboxErrorKind => {
  if (KINDS.includes(code as SandboxErrorKind)) {
    return code as SandboxErrorKind;
  }
  if (status === 401 || status === 503) return "config";
  if (status === 429) return "rate_limit";
  return "transient";
};

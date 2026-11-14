/**
 * What PATCH /api/sandbox/[sandboxId] reports for a failed reinstall (#497).
 * Never the output itself: it can hold secrets the boot injected, including
 * ones rotated or deleted since, which no redaction list still knows. The fix
 * run reads the full output through checkBuild instead.
 */
export interface InstallFailure {
  exitCode: number;
  /** npm's error code, e.g. ERESOLVE, which the error recipes are keyed on. */
  code?: string;
}

// Strict, so only a code's own characters can leave the sandbox.
const NPM_ERROR_CODE = /npm (?:ERR!|error) code ([A-Z0-9_]+)\b/g;

export const installFailure = (result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): InstallFailure => {
  // The last code says which failure this is.
  const code = [...`${result.stdout}\n${result.stderr}`.matchAll(NPM_ERROR_CODE)].at(-1)?.[1];
  return code ? { exitCode: result.exitCode, code } : { exitCode: result.exitCode };
};

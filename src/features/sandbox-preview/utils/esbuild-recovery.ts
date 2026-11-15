import type { AppError } from "./app-error";

export const ESBUILD_RECOVERY_COOLDOWN_MS = 2 * 60_000;
export const MAX_ESBUILD_RECOVERIES = 3;

/** These build errors mean Vite lost esbuild, rather than finding invalid source. */
export const isEsbuildServiceFailure = (error: AppError | null) => Boolean(
  error &&
  (error.kind === "build" || /esbuild/i.test(`${error.file ?? ""}\n${error.stack ?? ""}`)) &&
  /\bEPIPE\b|The service is no longer running|The service was stopped/i.test(error.message),
);

export interface EsbuildRecoveryAttempts {
  attempts: number;
  lastAttemptAt: number;
}

/** Reserve before starting asynchronous work, so duplicate reports cannot restart twice. */
export const nextEsbuildRecovery = (previous: EsbuildRecoveryAttempts | undefined, now: number): EsbuildRecoveryAttempts | null =>
  previous && (previous.attempts >= MAX_ESBUILD_RECOVERIES || now - previous.lastAttemptAt < ESBUILD_RECOVERY_COOLDOWN_MS)
    ? null
    : { attempts: (previous?.attempts ?? 0) + 1, lastAttemptAt: now };

export type EsbuildRecoveryStatus = "restarted" | "busy" | "limited" | "unavailable";

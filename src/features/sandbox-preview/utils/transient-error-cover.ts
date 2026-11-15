export const TRANSIENT_ERROR_IDLE_MS = 60_000;

export type TransientErrorCover = {
  lastActivityAt: number;
  covered: boolean;
} | null;

/** Keep mid-edit errors covered across file/reload clears, but never beyond the run. */
export const transientErrorCover = (
  previous: TransientErrorCover,
  runActive: boolean,
  hasError: boolean,
  activity: boolean,
  now: number,
): TransientErrorCover => {
  if (!runActive) return null;
  if (!previous) {
    return hasError ? { lastActivityAt: now, covered: true } : null;
  }
  // Only run/file activity renews the bound; repeated error reports cannot hide it forever.
  if (activity) return { lastActivityAt: now, covered: true };
  if (previous.covered && now - previous.lastActivityAt >= TRANSIENT_ERROR_IDLE_MS) {
    return { ...previous, covered: false };
  }
  return previous;
};

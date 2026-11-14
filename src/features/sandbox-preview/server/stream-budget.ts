/**
 * Vercel's Hobby plan stops a function at 300 s, so the preview's boot stream
 * ends itself first, without killing the sandbox (#492).
 */
export const STREAM_BUDGET_MS = 270_000;

/** A reinstall still running when the stream budget runs out may go on until here. */
export const CLOSE_BUDGET_MS = 290_000;

/** What is left of a request that started at `startedAt`; negative once past. */
export const streamBudget = (startedAt: number, now: () => number = Date.now) => ({
  /** Until the stream should end. */
  left: () => startedAt + STREAM_BUDGET_MS - now(),
  /** Until the function must have closed. */
  closeLeft: () => startedAt + CLOSE_BUDGET_MS - now(),
});

/** At most `maxMs` and what is `left`, and never 0, which E2B reads as no timeout. */
export const boundedTimeout = (maxMs: number, left: number) =>
  Math.max(1_000, Math.min(maxMs, left));

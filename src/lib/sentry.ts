/** Trace sample rate used when NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE is unset. */
export const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

/**
 * Parses a trace sample rate from env. Returns the default for an unset,
 * non-numeric, or out-of-range value, so a typo cannot send 100% of traces or
 * hand Sentry a NaN.
 */
export function parseTracesSampleRate(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = Number(value);
  return rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

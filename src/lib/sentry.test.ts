import { describe, expect, it } from "vitest";

import { DEFAULT_TRACES_SAMPLE_RATE, parseTracesSampleRate } from "./sentry";

describe("parseTracesSampleRate", () => {
  it("uses the default when unset or blank", () => {
    expect(parseTracesSampleRate(undefined)).toBe(DEFAULT_TRACES_SAMPLE_RATE);
    expect(parseTracesSampleRate("")).toBe(DEFAULT_TRACES_SAMPLE_RATE);
    expect(parseTracesSampleRate("  ")).toBe(DEFAULT_TRACES_SAMPLE_RATE);
  });

  it("accepts rates from 0 to 1", () => {
    expect(parseTracesSampleRate("0")).toBe(0);
    expect(parseTracesSampleRate("0.25")).toBe(0.25);
    expect(parseTracesSampleRate("1")).toBe(1);
  });

  it("falls back to the default for invalid values", () => {
    expect(parseTracesSampleRate("abc")).toBe(DEFAULT_TRACES_SAMPLE_RATE);
    expect(parseTracesSampleRate("-0.1")).toBe(DEFAULT_TRACES_SAMPLE_RATE);
    expect(parseTracesSampleRate("10")).toBe(DEFAULT_TRACES_SAMPLE_RATE);
  });
});

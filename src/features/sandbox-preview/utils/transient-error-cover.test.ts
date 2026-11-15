import { describe, expect, it } from "vitest";

import { TRANSIENT_ERROR_IDLE_MS, transientErrorCover } from "./transient-error-cover";

describe("transientErrorCover", () => {
  it("leaves clean runs and idle errors uncovered", () => {
    expect(transientErrorCover(null, true, false, false, 0)).toBeNull();
    expect(transientErrorCover(null, false, true, false, 0)).toBeNull();
  });

  it("latches through error clears and releases on run end, even with an error", () => {
    const covered = transientErrorCover(null, true, true, false, 0);
    expect(covered?.covered).toBe(true);
    expect(transientErrorCover(covered, true, false, false, 1000)).toBe(covered);
    expect(transientErrorCover(covered, false, true, false, 2000)).toBeNull();
  });

  it("reveals a stalled run's error at 60 seconds without renewing on repeat errors", () => {
    const covered = transientErrorCover(null, true, true, false, 5000);
    expect(transientErrorCover(covered, true, true, false, 5000 + TRANSIENT_ERROR_IDLE_MS - 1)).toBe(covered);
    const expired = transientErrorCover(covered, true, true, false, 5000 + TRANSIENT_ERROR_IDLE_MS);
    expect(expired?.covered).toBe(false);
    expect(transientErrorCover(expired, true, true, false, 100_000)).toBe(expired);
  });

  it("renews the bound only when run or file activity resumes", () => {
    const covered = transientErrorCover(null, true, true, false, 0);
    const renewed = transientErrorCover(covered, true, false, true, 50_000);
    expect(transientErrorCover(renewed, true, false, false, 60_000)?.covered).toBe(true);
    const expired = transientErrorCover(renewed, true, true, false, 110_000);
    expect(expired?.covered).toBe(false);
    expect(transientErrorCover(expired, true, true, true, 120_000)?.covered).toBe(true);
  });

  it("starts a later run without the old latch", () => {
    const covered = transientErrorCover(null, true, true, false, 0);
    const ended = transientErrorCover(covered, false, true, false, 1000);
    expect(transientErrorCover(ended, true, false, true, 2000)).toBeNull();
    expect(transientErrorCover(ended, true, true, true, 2000)).toEqual({
      lastActivityAt: 2000, covered: true,
    });
  });
});

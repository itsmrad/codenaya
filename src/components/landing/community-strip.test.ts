import { describe, expect, it } from "vitest";

import { fullRowCount } from "./community-strip";

describe("fullRowCount (#253)", () => {
  it.each([
    // count, shown at 2 columns (sm), shown at 3 columns (lg)
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [3, 2, 3],
    [4, 4, 3],
    [5, 4, 3],
    [6, 6, 6],
  ])("shows %i entries as %i cards in 2 columns and %i in 3, with no lone last card", (count, two, three) => {
    expect(fullRowCount(count, 2)).toBe(two);
    expect(fullRowCount(count, 3)).toBe(three);
  });
});

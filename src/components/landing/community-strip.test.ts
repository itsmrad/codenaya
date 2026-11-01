import { describe, expect, it } from "vitest";

import { fullRowCount } from "./community-strip";

describe("fullRowCount (#253)", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 4],
    [5, 4],
    [6, 4],
  ])("shows %i entries as %i cards, so the 2- and 4-column grids have no orphan", (count, shown) => {
    expect(fullRowCount(count)).toBe(shown);
    if (shown >= 2) expect(shown % 2).toBe(0);
  });
});

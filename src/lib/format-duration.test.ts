import { expect, it } from "vitest";

import { formatDuration } from "./format-duration";

it("formats the shared elapsed clock at the minute boundary", () => {
  expect(formatDuration(0)).toBe("1s");
  expect(formatDuration(2500)).toBe("3s");
  expect(formatDuration(59_000)).toBe("59s");
  expect(formatDuration(60_000)).toBe("1m 0s");
  expect(formatDuration(125_000)).toBe("2m 5s");
});

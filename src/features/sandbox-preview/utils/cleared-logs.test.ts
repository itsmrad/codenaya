import { describe, expect, it } from "vitest";

import { logsAfterClear } from "./cleared-logs";

describe("logsAfterClear (#480)", () => {
  it("shows everything until the user clears", () => {
    expect(logsAfterClear("npm install\nready\n", "")).toBe("npm install\nready\n");
  });

  it("shows only what arrived after the clear", () => {
    const cleared = "npm install\nready\n";
    expect(logsAfterClear(cleared, cleared)).toBe("");
    expect(logsAfterClear(`${cleared}GET / 200\n`, cleared)).toBe("GET / 200\n");
  });

  it("shows a restarted preview's output in full", () => {
    expect(logsAfterClear("booting again\n", "npm install\nready\n")).toBe("booting again\n");
  });
});

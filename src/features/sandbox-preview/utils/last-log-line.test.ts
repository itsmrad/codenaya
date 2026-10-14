import { describe, expect, it } from "vitest";

import { lastLogLine } from "./last-log-line";

describe("lastLogLine", () => {
  it("returns the last non-empty line", () => {
    expect(lastLogLine("$ npm install\nadded 42 packages\n\n")).toBe("added 42 packages");
  });

  it("strips colour and OSC escape codes", () => {
    expect(
      lastLogLine("\x1b[32m  VITE v5.4.0\x1b[39m  ready in \x1b[1m312\x1b[22m ms\n"),
    ).toBe("VITE v5.4.0  ready in 312 ms");
    expect(lastLogLine("\x1b]0;npm run dev\x07listening\n")).toBe("listening");
  });

  it("keeps only the text after the last carriage return", () => {
    expect(lastLogLine("progress 10%\rprogress 90%\rdone\r\n")).toBe("done");
  });

  it("finds the last line at the end of a long buffer", () => {
    expect(lastLogLine(`${"added 1 package\n".repeat(10_000)}ready\n`)).toBe("ready");
  });

  it("returns an empty string when there is no output", () => {
    expect(lastLogLine("")).toBe("");
    expect(lastLogLine("\n\x1b[2K\n")).toBe("");
  });
});

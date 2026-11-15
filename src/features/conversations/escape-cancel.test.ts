import { describe, expect, it } from "vitest";

import { OPEN_OVERLAY, shouldEscapeCancelRun } from "./escape-cancel";

const esc = (init: Partial<KeyboardEvent> = {}) =>
  ({ key: "Escape", defaultPrevented: false, repeat: false, ...init }) as KeyboardEvent;
// Stands in for the document: holds an open overlay or doesn't.
const page = (overlayOpen: boolean) => ({
  querySelector: (selector: string) =>
    overlayOpen && selector === OPEN_OVERLAY ? ({} as Element) : null,
});

describe("shouldEscapeCancelRun", () => {
  it("cancels when nothing is open", () => {
    expect(shouldEscapeCancelRun(esc(), page(false))).toBe(true);
  });

  it("leaves the run alone when Esc closes an open overlay (#608)", () => {
    expect(shouldEscapeCancelRun(esc(), page(true))).toBe(false);
  });

  it("leaves the run alone when something else handled Esc, or the key is held", () => {
    expect(shouldEscapeCancelRun(esc({ defaultPrevented: true }), page(false))).toBe(false);
    expect(shouldEscapeCancelRun(esc({ repeat: true }), page(false))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldEscapeCancelRun(esc({ key: "Enter" }), page(false))).toBe(false);
  });
});

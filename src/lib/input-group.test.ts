import { describe, expect, it } from "vitest";

import { shouldFocusGroupInput } from "./input-group";

const target = (insideButton: boolean) => ({ closest: () => (insideButton ? ({} as Element) : null) });

describe("shouldFocusGroupInput", () => {
  it("focuses the input for a user click on empty addon space", () => {
    expect(shouldFocusGroupInput({ isTrusted: true }, target(false))).toBe(true);
  });

  it("leaves clicks on buttons alone", () => {
    expect(shouldFocusGroupInput({ isTrusted: true }, target(true))).toBe(false);
  });

  it("ignores the untrusted click a Radix radio dispatches on mode change (keeps the textarea focused)", () => {
    expect(shouldFocusGroupInput({ isTrusted: false }, target(false))).toBe(false);
  });
});

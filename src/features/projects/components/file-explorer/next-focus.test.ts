import { describe, expect, it } from "vitest";
import { nextFocusAfterDelete } from "./next-focus";

const siblings = [{ _id: "folder" }, { _id: "a" }, { _id: "b" }];

describe("nextFocusAfterDelete", () => {
  it("prefers the next displayed sibling", () => {
    expect(nextFocusAfterDelete(siblings, "folder")).toBe("a");
    expect(nextFocusAfterDelete(siblings, "a")).toBe("b");
  });
  it("uses the previous sibling for the last row", () => {
    expect(nextFocusAfterDelete(siblings, "b")).toBe("a");
  });
  it("falls back to the header without a sibling", () => {
    expect(nextFocusAfterDelete([{ _id: "only" }], "only")).toBeNull();
    expect(nextFocusAfterDelete([], "missing")).toBeNull();
    expect(nextFocusAfterDelete(siblings, "missing")).toBeNull();
  });
});

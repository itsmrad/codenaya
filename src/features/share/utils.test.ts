import { expect, it } from "vitest";
import { sharePath } from "./utils";

it("builds the website-only share path", () => {
  expect(sharePath("abc")).toBe("/preview/abc");
});

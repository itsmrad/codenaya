import { expect, it } from "vitest";
import { canUncancel } from "./subscription-controls";
const input = { deleted: false, held: false, renewable: true, cancelAt: 200, paidThrough: 200 };
it("requires an unexpired settled scheduled renewal with live, unheld ownership", () => {
  expect(canUncancel(input, 199)).toBe(true);
  for (const over of [{ deleted: true }, { held: true }, { renewable: false }, { cancelAt: undefined }, { paidThrough: undefined }]) {
    expect(canUncancel({ ...input, ...over }, 199)).toBe(false);
  }
  expect(canUncancel(input, 200)).toBe(false);
  expect(canUncancel(input, 201)).toBe(false);
});

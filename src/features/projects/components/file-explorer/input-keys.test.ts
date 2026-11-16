import { expect, it, vi } from "vitest";
import { onEntryKeyDown } from "./input-keys";

const press = (key: string) => {
  const calls: string[] = [];
  const event = { key, preventDefault: vi.fn(() => calls.push("preventDefault")) };
  const submit = vi.fn(() => calls.push("submit"));
  const cancel = vi.fn(() => calls.push("cancel"));
  onEntryKeyDown(event, submit, cancel);
  return { calls, event, submit, cancel };
};

it("prevents Enter's default action before submitting", () => {
  const { calls, cancel } = press("Enter");
  expect(calls).toEqual(["preventDefault", "submit"]);
  expect(cancel).not.toHaveBeenCalled();
});

it("cancels on Escape without submitting", () => {
  const { calls, submit, event } = press("Escape");
  expect(calls).toEqual(["cancel"]);
  expect(submit).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("ignores other keys", () => {
  const { calls } = press("a");
  expect(calls).toEqual([]);
});

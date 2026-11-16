import { expect, it, vi } from "vitest";
import { onEntryKeyDown } from "./input-keys";

const press = (key: string, composition: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } } = {}) => {
  const calls: string[] = [];
  const event = { key, ...composition, preventDefault: vi.fn(() => calls.push("preventDefault")) };
  const submit = vi.fn(() => calls.push("submit"));
  const cancel = vi.fn(() => calls.push("cancel"));
  onEntryKeyDown(event, submit, cancel);
  return { calls, event, submit, cancel };
};

it("prevents Enter's default action before submitting", () => {
  const { calls, cancel, submit } = press("Enter");
  expect(submit).toHaveBeenCalledWith(true);
  expect(calls).toEqual(["preventDefault", "submit"]);
  expect(cancel).not.toHaveBeenCalled();
});

it("cancels on Escape without submitting", () => {
  const { calls, submit, event, cancel } = press("Escape");
  expect(cancel).toHaveBeenCalledWith(true);
  expect(calls).toEqual(["cancel"]);
  expect(submit).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("ignores other keys", () => {
  const { calls } = press("a");
  expect(calls).toEqual([]);
});

it.each([{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }])("ignores IME Enter (%j)", (composition) => {
  const { calls } = press("Enter", composition);
  expect(calls).toEqual([]);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dismiss = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { dismiss } }));

import { peekPendingPrompt, savePendingPrompt } from "@/features/projects/utils/pending-prompt";
import { peekPendingTemplate, savePendingTemplate } from "@/features/templates/utils/pending-template";
import { getProjectHandoff, resetProjectHandoff, runProjectHandoff } from "@/features/projects/utils/project-handoff";
import { clearPendingStartsOnUserChange } from "./clear-pending-starts";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  resetProjectHandoff();
  dismiss.mockClear();
  savePendingPrompt("A blog");
  savePendingTemplate("blog");
});
afterEach(() => vi.unstubAllGlobals());

it.each([null, "another-user"])("clears both handoffs on sign-out/account switch to %s", (current) => {
  clearPendingStartsOnUserChange("user", current);
  expect(peekPendingPrompt()).toBeNull();
  expect(peekPendingTemplate()).toBeNull();
});

it.each([
  [undefined, "user"], [null, "user"], ["user", "user"], ["user", undefined],
])("preserves the handoff during auth loading and sign-in (%s → %s)", (previous, current) => {
  clearPendingStartsOnUserChange(previous, current);
  expect(peekPendingPrompt()).toBe("A blog");
  expect(peekPendingTemplate()?.id).toBe("blog");
});

const EMPTY = { phase: "idle", draft: null };
const failStart = () => runProjectHandoff({ prompt: "A's secret", mode: "plan", templateId: "blog" }, async () => false);

it.each([null, "user-b"])("forgets the recovered draft of a failed start on sign-out/account switch to %s", async (current) => {
  await failStart();
  expect(getProjectHandoff().draft?.prompt).toBe("A's secret");
  clearPendingStartsOnUserChange("user-a", current);
  expect(getProjectHandoff()).toMatchObject(EMPTY);
});

it.each([
  [undefined, "user-a"], [null, "user-a"], ["user-a", "user-a"], ["user-a", undefined],
])("keeps the in-memory draft during auth loading and sign-in (%s → %s)", async (previous, current) => {
  await failStart();
  clearPendingStartsOnUserChange(previous, current);
  expect(getProjectHandoff().draft?.prompt).toBe("A's secret");
});

it("dismisses the saved-prompt retry toast on a user change only", () => {
  clearPendingStartsOnUserChange(null, "user-a");
  expect(dismiss).not.toHaveBeenCalled();
  clearPendingStartsOnUserChange("user-a", "user-b");
  expect(dismiss).toHaveBeenCalledWith("pending-prompt-retry");
});

it("ignores an attempt of the previous user that finishes after the switch", async () => {
  let finish!: (created: boolean) => void;
  const stale = runProjectHandoff({ prompt: "A's secret" }, () => new Promise<boolean>((resolve) => { finish = resolve; }));
  clearPendingStartsOnUserChange("user-a", "user-b");
  expect(getProjectHandoff()).toMatchObject(EMPTY);
  await Promise.resolve(); // create() runs a microtask after runProjectHandoff, which assigns `finish`.
  finish(false);
  await stale;
  expect(getProjectHandoff()).toMatchObject(EMPTY);
});

it("lets the next user's attempt run while the previous user's is still in flight", async () => {
  let finishA!: (created: boolean) => void;
  let finishB!: (created: boolean) => void;
  const stale = runProjectHandoff({ prompt: "A's secret" }, () => new Promise<boolean>((resolve) => { finishA = resolve; }));
  clearPendingStartsOnUserChange("user-a", "user-b");
  const next = runProjectHandoff({ prompt: "B's prompt" }, () => new Promise<boolean>((resolve) => { finishB = resolve; }));
  await Promise.resolve(); // Both create() callbacks have run, so finishA/finishB are assigned.
  finishA(false);
  await stale;
  expect(getProjectHandoff()).toMatchObject({ phase: "creating", draft: { prompt: "B's prompt" } });
  finishB(false);
  await next;
  expect(getProjectHandoff().draft?.prompt).toBe("B's prompt");
});

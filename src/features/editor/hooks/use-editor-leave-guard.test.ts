import { afterEach, expect, test, vi } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { clearProjectSessions, EditorSession, getProjectSessions } from "../editor-session";
// Called as a plain function here, with useEffect mocked.
import { confirmLeaveEditor, guardLeaveClick, useEditorLeaveGuard as mountLeaveGuard } from "./use-editor-leave-guard";

// Run each effect like StrictMode does in dev: mount, clean up, mount again; the last cleanup is the unmount.
const effects = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => (() => void) | void) => {
    (effect() ?? (() => {}))();
    const cleanup = effect();
    if (cleanup) effects.cleanups.push(cleanup);
  },
}));

const projectId = "project" as Id<"projects">;
const otherId = "other" as Id<"projects">;
const fileId = "file" as Id<"files">;

const stubBrowser = (confirm = vi.fn(() => false)) => {
  class FakeElement {}
  const listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("window", { confirm, location: new URL(`https://app.test/projects/${projectId}`), ...listeners });
  vi.stubGlobal("document", listeners);
  vi.stubGlobal("Element", FakeElement);
  return { confirm, FakeElement };
};

const conflictedSession = (id = projectId) => {
  const session = new EditorSession("base", vi.fn());
  getProjectSessions(id).set(fileId, session);
  session.edit("mine");
  session.receive("theirs");
  return session;
};

afterEach(() => {
  clearProjectSessions(projectId);
  clearProjectSessions(otherId);
  effects.cleanups = [];
  vi.unstubAllGlobals();
});

test("leaving the project with an open conflict asks first and a confirmed leave discards (#604, #618)", () => {
  const { confirm } = stubBrowser();
  const session = new EditorSession("base", vi.fn());
  getProjectSessions(projectId).set(fileId, session);

  expect(confirmLeaveEditor("/settings")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();

  session.edit("mine");
  session.receive("theirs");
  // In-project links, whatever their path or query, and other sites never prompt.
  expect(confirmLeaveEditor(`/projects/${projectId}?view=preview`)).toBe(true);
  expect(confirmLeaveEditor(`/projects/${projectId}/files`)).toBe(true);
  expect(confirmLeaveEditor("https://docs.example/")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();

  expect(confirmLeaveEditor("/settings")).toBe(false);
  expect(getProjectSessions(projectId).get(fileId)).toBe(session);
  confirm.mockReturnValue(true);
  expect(confirmLeaveEditor("/projects/other")).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(getProjectSessions(projectId).size).toBe(0);
});

test("outside the conflicted project, navigation never prompts", () => {
  const { confirm } = stubBrowser();
  conflictedSession();
  vi.stubGlobal("window", { confirm, location: new URL("https://app.test/settings") });
  expect(confirmLeaveEditor("/")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
});

test("a conflicted draft survives StrictMode double-mount and unmount until another project opens (#618)", () => {
  stubBrowser();
  const session = conflictedSession();
  mountLeaveGuard(projectId);
  expect(getProjectSessions(projectId).get(fileId)).toBe(session);

  // Back/Forward or router.push to another route unmounts the project view.
  effects.cleanups.forEach((cleanup) => cleanup());
  expect(getProjectSessions(projectId).get(fileId)).toBe(session);

  // Coming back keeps it; opening another project drops it.
  mountLeaveGuard(projectId);
  expect(getProjectSessions(projectId).get(fileId)).toBe(session);
  mountLeaveGuard(otherId);
  expect(getProjectSessions(projectId).size).toBe(0);
});

test("the capture click guard blocks only a declined plain click that leaves the project", () => {
  const { confirm, FakeElement } = stubBrowser();
  conflictedSession();
  const click = (href: string, init: Partial<MouseEvent> = {}, link: Record<string, unknown> = {}) => {
    const anchor = { href: new URL(href, "https://app.test").href, target: "", hasAttribute: () => false, ...link };
    const target = Object.assign(new FakeElement(), { closest: () => anchor });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    guardLeaveClick({ defaultPrevented: false, button: 0, target, preventDefault, stopPropagation, ...init } as unknown as MouseEvent);
    return preventDefault.mock.calls.length > 0 && stopPropagation.mock.calls.length > 0;
  };

  expect(click("/settings")).toBe(true);
  expect(click(`/projects/${projectId}?view=preview`)).toBe(false);
  expect(click("/settings", { metaKey: true })).toBe(false);
  expect(click("/settings", { button: 1 })).toBe(false);
  expect(click("/settings", { defaultPrevented: true })).toBe(false);
  expect(click("/settings", {}, { target: "_blank" })).toBe(false);
  expect(click("/settings", {}, { hasAttribute: () => true })).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);

  confirm.mockReturnValue(true);
  expect(click("/settings")).toBe(false);
});

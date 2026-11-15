import { afterEach, expect, test, vi } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { clearProjectSessions, EditorSession, getProjectSessions } from "../editor-session";
import { confirmLeaveEditor } from "./use-editor-leave-guard";

const projectId = "project" as Id<"projects">;

afterEach(() => {
  clearProjectSessions(projectId);
  vi.unstubAllGlobals();
});

test("leaving the project with an open conflict asks first (#604)", () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("window", { confirm, location: new URL(`https://app.test/projects/${projectId}`) });
  const session = new EditorSession("base", vi.fn());
  getProjectSessions(projectId).set("file" as Id<"files">, session);

  expect(confirmLeaveEditor("/settings")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();

  session.edit("mine");
  session.receive("theirs");
  expect(confirmLeaveEditor(`/projects/${projectId}?view=preview`)).toBe(true);
  expect(confirmLeaveEditor("https://docs.example/")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();

  expect(confirmLeaveEditor("/settings")).toBe(false);
  confirm.mockReturnValue(true);
  expect(confirmLeaveEditor("/projects/other")).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(2);
});

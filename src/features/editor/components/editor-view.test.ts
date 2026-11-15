import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { clearProjectSessions, getProjectSessions } from "../editor-session";
import { EditorView } from "./editor-view";

const fileId = "file" as Id<"files">;
const file = { _id: fileId, name: "booking.tsx", content: "old heading" };

vi.mock("@/features/projects/hooks/use-files", () => ({ useFile: () => file, useUpdateFile: () => vi.fn() }));
vi.mock("../hooks/use-editor", () => ({ useEditor: () => ({ activeTabId: fileId }) }));
vi.mock("./top-navigation", () => ({ TopNavigation: () => null }));
vi.mock("./file-breadcrumbs", () => ({ FileBreadcrumbs: () => null }));
vi.mock("./code-editor", () => ({ CodeEditor: ({ initialValue }: { initialValue: string }) => createElement("pre", null, initialValue) }));

test("a conflicted draft survives an EditorView remount and stays in its own project (#604)", () => {
  const projectA = "projectA" as Id<"projects">;
  const projectB = "projectB" as Id<"projects">;
  const mount = (projectId: Id<"projects">) => renderToStaticMarkup(createElement(EditorView, { projectId }));

  mount(projectA);
  const session = getProjectSessions(projectA).get(fileId)!;
  session.edit("my unsaved heading");
  session.receive("new agent heading");
  file.content = "new agent heading";

  // A workspace mode switch or breakpoint crossing unmounts and mounts EditorView again.
  const remounted = mount(projectA);
  expect(remounted).toContain("my unsaved heading");
  expect(remounted).toContain("Keep my edits");

  const otherProject = mount(projectB);
  expect(otherProject).not.toContain("my unsaved heading");
  expect(otherProject).not.toContain('role="alert"');

  session.reload();
  clearProjectSessions(projectA);
  clearProjectSessions(projectB);
});

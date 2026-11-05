import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { useEditorStore } from "./use-editor-store";

const project = "project_a" as Id<"projects">;
const file = (id: string) => id as Id<"files">;

describe("useEditorStore.restoreTabs (#315)", () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: new Map() });
  });

  it("puts back the saved tabs and active tab, pinned", () => {
    useEditorStore.getState().restoreTabs(project, [file("f1"), file("f2")], file("f2"));
    expect(useEditorStore.getState().getTabState(project)).toEqual({
      openTabs: ["f1", "f2"],
      activeTabId: "f2",
      previewTabId: null,
    });
  });

  it("leaves tabs the user already opened alone", () => {
    useEditorStore.getState().openFile(project, file("mine"), { pinned: true });
    useEditorStore.getState().restoreTabs(project, [file("f1")], file("f1"));
    expect(useEditorStore.getState().getTabState(project).openTabs).toEqual(["mine"]);
  });

  it("keeps projects apart", () => {
    useEditorStore.getState().restoreTabs(project, [file("f1")], file("f1"));
    expect(useEditorStore.getState().getTabState("project_b" as Id<"projects">).openTabs).toEqual([]);
  });
});

import { ConvexError } from "convex/values";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { useEditorStore } from "../store/use-editor-store";
import { TopNavigation } from "./top-navigation";

const mocks = vi.hoisted(() => ({ useFile: vi.fn() }));

vi.mock("@/features/projects/hooks/use-files", () => ({ useFile: mocks.useFile }));
// Server rendering skips effects, and closing the tab is one.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => effect(),
}));
// zustand renders its initial state on the server, so read the real store directly.
vi.mock("../hooks/use-editor", async () => {
  const { useEditorStore: store } = await import("../store/use-editor-store");
  return {
    useEditor: (projectId: Id<"projects">) => ({
      ...store.getState().getTabState(projectId),
      closeTab: (fileId: Id<"files">) => store.getState().closeTab(projectId, fileId),
    }),
  };
});

const projectId = "project" as Id<"projects">;
const [a, b, c] = ["a", "b", "c"] as Id<"files">[];

const render = () => renderToStaticMarkup(createElement(TopNavigation, { projectId }));
const tabs = () => useEditorStore.getState().getTabState(projectId);
const open = (...ids: Id<"files">[]) =>
  ids.forEach((id) => useEditorStore.getState().openFile(projectId, id, { pinned: true }));

describe("TopNavigation with a file deleted while open", () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: new Map() });
    mocks.useFile.mockReset();
  });

  it("closes the deleted active tab, activates its neighbour and keeps the others", () => {
    open(a, b, c);
    useEditorStore.getState().setActiveTab(projectId, b);
    mocks.useFile.mockImplementation((id: Id<"files">) => (id === b ? null : { name: `${id}.ts` }));

    render();

    expect(tabs()).toMatchObject({ openTabs: [a, c], activeTabId: c });
  });

  it("leaves the empty editor state when the last tab's file is gone", () => {
    open(a);
    mocks.useFile.mockReturnValue(null);

    render();

    expect(tabs()).toMatchObject({ openTabs: [], activeTabId: null });
  });

  it("keeps a tab whose file is still loading", () => {
    open(a);
    mocks.useFile.mockReturnValue(undefined);

    render();

    expect(tabs().openTabs).toEqual([a]);
  });

  it.each([
    ["a missing project", new ConvexError({ code: "NOT_FOUND", message: "Project not found" })],
    ["any other failure", new Error("boom")],
  ])("lets %s reach the error boundary", (_name, error) => {
    open(a);
    mocks.useFile.mockImplementation(() => {
      throw error;
    });

    expect(render).toThrow(error);
    expect(tabs().openTabs).toEqual([a]);
  });
});

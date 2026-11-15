import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  files: undefined as unknown,
  messages: undefined as unknown,
  commands: {} as Record<string, () => void>,
  openFile: vi.fn(),
  // Static markup can't click: the Button stub records each onClick by its label.
  clicks: {} as Record<string, () => void>,
}));

vi.mock("../hooks/use-editor", () => ({ useEditor: () => ({ openFile: mocks.openFile }) }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ onClick, children, ...props }: { onClick: () => void; children: unknown; "aria-label"?: string }) => {
    if (props["aria-label"]) mocks.clicks[props["aria-label"]] = onClick;
    return createElement("button", props, children as never);
  },
}));
vi.mock("@/features/projects/hooks/use-files", () => ({ useFiles: () => mocks.files }));
vi.mock("@/features/conversations/hooks/use-conversations", () => ({
  useConversations: () => [{ _id: "c1" }],
  useMessages: () => mocks.messages,
}));
// zustand renders its initial state on the server, so the registered commands come from here.
vi.mock("@/lib/command-palette", () => ({
  useCommandPalette: (select: (state: { commands: typeof mocks.commands }) => unknown) =>
    select({ commands: mocks.commands }),
}));

import type { Id } from "../../../../convex/_generated/dataModel";
import { EditorEmptyState } from "./editor-empty-state";

const render = () =>
  renderToStaticMarkup(createElement(EditorEmptyState, { projectId: "p" as Id<"projects"> }));

describe("EditorEmptyState (#315)", () => {
  beforeEach(() => {
    mocks.files = [];
    mocks.messages = undefined;
    mocks.clicks = {};
    mocks.openFile.mockClear();
    mocks.commands = {};
  });

  it("offers the root README and the preview when both exist", () => {
    mocks.files = [{ _id: "f1", name: "README.md", type: "file" }];
    mocks.commands = { "show-preview": () => {} };
    const html = render();
    expect(html).toContain("Open README.md");
    expect(html).toContain("Open preview");
  });

  it("leaves out what the project or page can't offer", () => {
    // A README inside a folder isn't the project's README.
    mocks.files = [{ _id: "f1", name: "README.md", type: "file", parentId: "d1" }];
    const html = render();
    expect(html).not.toContain("Open README.md");
    expect(html).not.toContain("Open preview");
    expect(html).toContain("Pick a file in the explorer");
  });

  it("lists the last run's surviving written files above the next steps", () => {
    mocks.files = [
      { _id: "f1", name: "page.tsx", type: "file" },
      { _id: "f2", name: "gone.ts", type: "file", parentId: "d1" },
    ];
    mocks.messages = [
      {
        role: "assistant",
        steps: [{ id: "1", kind: "tool", tool: "writeFiles", targets: ["page.tsx", "old.ts"], status: "done", startedAt: 0 }],
      },
    ];
    const html = render();
    expect(html).toContain("Recently changed");
    expect(html).toContain("page.tsx");
    expect(html).not.toContain("old.ts");
  });

  it("opens a clicked entry pinned, and tells same-named files apart by path", () => {
    mocks.files = [
      { _id: "d1", name: "a", type: "folder" },
      { _id: "d2", name: "b", type: "folder" },
      { _id: "f1", name: "index.ts", type: "file", parentId: "d1" },
      { _id: "f2", name: "index.ts", type: "file", parentId: "d2" },
    ];
    mocks.messages = [
      {
        role: "assistant",
        steps: [{ id: "1", kind: "tool", tool: "writeFiles", targets: ["a/index.ts", "b/index.ts"], status: "done", startedAt: 0 }],
      },
    ];
    const html = render();
    expect(html).toContain('aria-label="a/index.ts"');
    expect(html).toContain('aria-label="b/index.ts"');
    mocks.clicks["b/index.ts"]();
    expect(mocks.openFile).toHaveBeenCalledWith("f2", { pinned: true });
  });

  it("shows no Recently changed section without a run", () => {
    expect(render()).not.toContain("Recently changed");
  });
});

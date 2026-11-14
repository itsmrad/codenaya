import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ files: undefined as unknown, commands: {} as Record<string, () => void> }));

vi.mock("@/features/projects/hooks/use-files", () => ({ useFiles: () => mocks.files }));
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
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { Id } from "../../../../../convex/_generated/dataModel";
import { FileExplorer } from "./index";

vi.mock("../../hooks/use-projects", () => ({
  useProject: () => ({ name: "Project" }),
}));
vi.mock("../../hooks/use-files", () => ({
  useFolderContents: () => [],
  useCreateFile: () => vi.fn(),
  useCreateFolder: () => vi.fn(),
}));
vi.mock("@/features/editor/hooks/use-editor", () => ({
  useEditor: () => ({ openFile: vi.fn() }),
}));
vi.mock("./tree", () => ({ Tree: () => null }));

it("keeps all explorer header actions visible without hover", () => {
  const html = renderToStaticMarkup(
    createElement(FileExplorer, { projectId: "project" as Id<"projects"> }),
  );
  const actions = html.match(/<div class="([^"]*group-hover\/project:opacity-100[^"]*)">([\s\S]*?)<\/div>/);

  expect(actions?.[1]).toContain("[@media(hover:none)]:opacity-100");
  for (const label of ["Create file", "Create folder", "Collapse all"]) {
    expect(actions?.[2]).toContain(`aria-label="${label}"`);
  }
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import type { Id } from "../../../../convex/_generated/dataModel";
import { EditorSession } from "../editor-session";
import { FileEditor } from "./file-editor";

vi.mock("@/features/projects/hooks/use-files", () => ({ useUpdateFile: () => vi.fn() }));
vi.mock("./code-editor", () => ({ CodeEditor: ({ initialValue }: { initialValue: string }) => createElement("pre", null, initialValue) }));

test("reopening a dirty tab retains its local buffer and shows the conflict choices (#581)", () => {
  const id = "file" as Id<"files">;
  const session = new EditorSession("old heading", vi.fn());
  session.edit("my unsaved heading");
  session.receive("new agent heading");
  const sessions = new Map([[id, session]]);
  const render = () => renderToStaticMarkup(createElement(FileEditor, {
    file: { _id: id, name: "booking.tsx", content: "new agent heading" }, sessions,
  }));
  for (let reopen = 0; reopen < 2; reopen++) {
    const html = render();
    expect(html).toContain("my unsaved heading");
    expect(html).toContain('role="alert"');
    expect(html).toContain("autosave is paused");
    expect(html).toContain("Reload file");
    expect(html).toContain("Keep my edits");
  }
  session.reload();
});

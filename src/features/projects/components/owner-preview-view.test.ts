import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OwnerPreviewView } from "./owner-preview-view";

it("frames the live preview without granting top navigation", () => {
  const html = renderToStaticMarkup(createElement(OwnerPreviewView, {
    projectId: "mine", initial: { name: "My project", previewUrl: "https://4000-live.e2b.app" },
  }));
  expect(html).toContain('src="https://4000-live.e2b.app"');
  expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"');
  expect(html).not.toContain("allow-top-navigation");
  expect(html).toContain('href="/projects/mine"');
  expect(html).toContain("My project");
});

it("offers the editor when no preview is running", () => {
  const html = renderToStaticMarkup(createElement(OwnerPreviewView, {
    projectId: "mine", initial: { name: "My project", previewUrl: null },
  }));
  expect(html).toContain("Start the preview from the editor");
  expect(html).not.toContain("<iframe");
});

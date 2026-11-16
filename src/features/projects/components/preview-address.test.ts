import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewAddress, previewAddressUrl } from "./preview-address";

describe("owner preview toolbar address", () => {
  it("shows and opens the same Codenaya URL while a sandbox is running", () => {
    const sandboxUrl = "https://4000-test.e2b.app";
    const url = previewAddressUrl("https://codenaya.com", "project123", "sandbox", sandboxUrl);
    expect(url).toBe("https://codenaya.com/p/project123/preview");
    const html = renderToStaticMarkup(createElement(PreviewAddress, {
      url, running: Boolean(sandboxUrl), loadingLabel: null, waitingLabel: null,
    }));
    expect(html).toContain(`value="${url}"`);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('aria-label="Preview address"');
    expect(html).not.toContain("e2b.app");
  });

  it("has no outbound link until a preview is running", () => {
    const html = renderToStaticMarkup(createElement(PreviewAddress, {
      url: previewAddressUrl("https://codenaya.com", "project123", "sandbox", null),
      running: false, loadingLabel: null, waitingLabel: "Ready to preview",
    }));
    expect(html).not.toContain("href=");
    expect(html).toContain("Ready to preview");
  });
});

it("preserves the running WebContainer address and open-tab destination", () => {
  const browserUrl = "https://browser-preview.example/";
  const url = previewAddressUrl("https://codenaya.com", "project123", "webcontainer", browserUrl);
  expect(url).toBe(browserUrl);
  const html = renderToStaticMarkup(createElement(PreviewAddress, { url, running: true, loadingLabel: null, waitingLabel: null }));
  expect(html).toContain(`href="${browserUrl}"`);
  expect(html).toContain(`value="${browserUrl}"`);
  expect(html).not.toContain("/p/project123/preview");
});

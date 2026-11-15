import { describe, expect, it } from "vitest";

import { previewEngineUrl } from "./preview-engine";

describe("previewEngineUrl", () => {
  it("drops the WebContainer parameter before loading a Next sandbox preview", () => {
    const url = new URL(previewEngineUrl("/projects/one", "engine=webcontainer&foo=bar", "sandbox"), "https://example.com");
    expect(url.pathname).toBe("/projects/one");
    expect(url.searchParams.has("engine")).toBe(false);
    expect(url.searchParams.get("view")).toBe("preview");
    expect(url.searchParams.get("foo")).toBe("bar");
  });

  it("retains the explicit browser engine choice for supported projects", () => {
    expect(previewEngineUrl("/projects/one", "view=editor", "webcontainer")).toBe("/projects/one?view=preview&engine=webcontainer");
  });
});

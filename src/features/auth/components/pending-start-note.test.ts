import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/sign-up" }));

import { PendingStartNote, PROMPT_PREVIEW_LENGTH, previewPrompt } from "./pending-start-note";

describe("PendingStartNote (#252)", () => {
  it("renders nothing on the server, where storage can't be read", () => {
    expect(renderToStaticMarkup(createElement(PendingStartNote))).toBe("");
  });

  it("shows short prompts whole and cuts long ones without splitting an emoji", () => {
    expect(previewPrompt("A habit tracker")).toBe("A habit tracker");
    const long = `${"a".repeat(PROMPT_PREVIEW_LENGTH - 1)}😀 and more`;
    expect(previewPrompt(long)).toBe(`${"a".repeat(PROMPT_PREVIEW_LENGTH - 1)}😀…`);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerImages } from "./composer-attachments";

vi.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: [{ id: "1" }] }),
  PromptInputAttachments: () => null,
  PromptInputAttachment: () => null,
  PromptInputButton: () => null,
}));

const render = () =>
  renderToStaticMarkup(
    createElement(ComposerImages, {
      acceptsImages: false,
      visionSwitch: { choice: { modelId: "m" }, name: "Sonnet", billing: "Uses your credits" },
      onSwitchModel: () => {},
    }),
  );

describe("ComposerImages vision switch", () => {
  it("describes the Switch button by the billing note", () => {
    const html = render();
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${id}"[^>]*>\\s*Uses your credits`));
  });
});

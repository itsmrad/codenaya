import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { PromptInputSpeechButton } from "./prompt-input";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("@/lib/dictation-recorder", () => ({ canRecordDictation: () => true }));

afterEach(() => vi.unstubAllGlobals());

it("keeps the dictation button without a language selector in web composers", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(createElement(PromptInputSpeechButton));
  expect(html).toContain('aria-label="Dictate"');
  expect(html).not.toContain('role="combobox"');
  expect(html).not.toContain("Dictation language");
  expect(html).not.toContain("Auto");
});

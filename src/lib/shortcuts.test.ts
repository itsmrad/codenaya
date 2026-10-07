import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHORTCUTS, SHORTCUT_SCOPES, formatShortcutKey, isShortcutSheetKey } from "./shortcuts";

describe("formatShortcutKey", () => {
  it("uses Mac symbols on Mac and words elsewhere", () => {
    expect(formatShortcutKey("mod", true)).toBe("⌘");
    expect(formatShortcutKey("mod", false)).toBe("Ctrl");
    expect(formatShortcutKey("shift", true)).toBe("⇧");
    expect(formatShortcutKey("shift", false)).toBe("Shift");
  });

  it("names special keys and upper-cases letters", () => {
    expect(formatShortcutKey("esc", true)).toBe("Esc");
    expect(formatShortcutKey("enter", false)).toBe("Enter");
    expect(formatShortcutKey("k", false)).toBe("K");
    expect(formatShortcutKey("/", true)).toBe("/");
  });
});

describe("SHORTCUTS", () => {
  it("only uses known scopes", () => {
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUT_SCOPES).toContain(shortcut.scope);
    }
  });
});

describe("isShortcutSheetKey", () => {
  // Tests run in Node, so stand in for the DOM element class.
  class FakeElement {
    constructor(
      public tagName: string,
      public isContentEditable = false,
    ) {}
  }

  beforeEach(() => {
    vi.stubGlobal("HTMLElement", FakeElement);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const keyEvent = (init: Partial<KeyboardEvent>) =>
    ({
      key: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      defaultPrevented: false,
      target: new FakeElement("BODY"),
      ...init,
    }) as KeyboardEvent;

  it("opens on ? outside text fields", () => {
    expect(isShortcutSheetKey(keyEvent({ key: "?" }))).toBe(true);
  });

  it("ignores ? typed into inputs, textareas and editors", () => {
    for (const target of [
      new FakeElement("INPUT"),
      new FakeElement("TEXTAREA"),
      new FakeElement("DIV", true),
    ]) {
      expect(isShortcutSheetKey(keyEvent({ key: "?", target: target as unknown as EventTarget }))).toBe(false);
    }
  });

  it("opens on Cmd/Ctrl+/ even in a text field", () => {
    const target = new FakeElement("TEXTAREA") as unknown as EventTarget;
    expect(isShortcutSheetKey(keyEvent({ key: "/", ctrlKey: true, target }))).toBe(true);
    expect(isShortcutSheetKey(keyEvent({ key: "/", metaKey: true }))).toBe(true);
  });

  it("leaves keys another handler already took", () => {
    expect(isShortcutSheetKey(keyEvent({ key: "/", ctrlKey: true, defaultPrevented: true }))).toBe(false);
    expect(isShortcutSheetKey(keyEvent({ key: "/" }))).toBe(false);
  });
});

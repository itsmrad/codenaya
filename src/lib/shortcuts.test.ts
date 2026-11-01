import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHORTCUTS,
  SHORTCUT_SCOPES,
  formatShortcutKey,
  isCommandPaletteKey,
  isShortcutSheetKey,
} from "./shortcuts";

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

  it("lists both command palette bindings under the IDE scope", () => {
    const ideKeys = SHORTCUTS.filter((shortcut) => shortcut.scope === "IDE").flatMap(
      (shortcut) => shortcut.keys.map((combo) => combo.join("+")),
    );
    expect(ideKeys).toEqual(expect.arrayContaining(["mod+k", "mod+shift+p"]));
  });

  it("keeps Cmd/Ctrl+K as quick edit in the editor", () => {
    expect(SHORTCUTS).toContainEqual(
      expect.objectContaining({ scope: "Editor", label: "Quick edit the selection", keys: [["mod", "k"]] }),
    );
  });
});

describe("isShortcutSheetKey", () => {
  // Tests run in Node, so stand in for the DOM element class.
  class FakeElement {
    constructor(
      public tagName: string,
      public isContentEditable = false,
      public inCodeEditor = false,
    ) {}

    closest(selector: string) {
      return selector === ".cm-editor" && this.inCodeEditor ? this : null;
    }
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
      shiftKey: false,
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

  describe("isCommandPaletteKey", () => {
    const editor = new FakeElement("DIV", true, true) as unknown as EventTarget;

    it("opens on Cmd/Ctrl+K outside the code editor, text fields included", () => {
      expect(isCommandPaletteKey(keyEvent({ key: "k", metaKey: true }))).toBe(true);
      const target = new FakeElement("TEXTAREA") as unknown as EventTarget;
      expect(isCommandPaletteKey(keyEvent({ key: "k", ctrlKey: true, target }))).toBe(true);
    });

    it("leaves Cmd/Ctrl+K to quick edit inside the code editor", () => {
      expect(isCommandPaletteKey(keyEvent({ key: "k", ctrlKey: true, target: editor }))).toBe(false);
    });

    it("opens on Cmd/Ctrl+Shift+P anywhere, the editor included", () => {
      expect(
        isCommandPaletteKey(keyEvent({ key: "P", ctrlKey: true, shiftKey: true, target: editor })),
      ).toBe(true);
      expect(isCommandPaletteKey(keyEvent({ key: "p", metaKey: true, shiftKey: true }))).toBe(true);
    });

    it("ignores other combos and keys another handler took", () => {
      expect(isCommandPaletteKey(keyEvent({ key: "k" }))).toBe(false);
      expect(isCommandPaletteKey(keyEvent({ key: "p", ctrlKey: true }))).toBe(false);
      expect(isCommandPaletteKey(keyEvent({ key: "K", ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(isCommandPaletteKey(keyEvent({ key: "k", ctrlKey: true, altKey: true }))).toBe(false);
      expect(isCommandPaletteKey(keyEvent({ key: "k", ctrlKey: true, defaultPrevented: true }))).toBe(false);
    });
  });
});

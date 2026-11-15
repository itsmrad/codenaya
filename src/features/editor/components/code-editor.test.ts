import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { afterEach, expect, test, vi } from "vitest";

// Exercise the component's effects with real CodeMirror transactions, without a browser.
const harness = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  views: [] as { state: EditorState; dispatch: (spec: TransactionSpec) => void }[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => {
    const i = harness.cursor++;
    return harness.slots[i] ??= { current: value };
  },
  useState: (value: unknown) => {
    const i = harness.cursor++;
    harness.slots[i] ??= typeof value === "function" ? value() : value;
    return [harness.slots[i], vi.fn()];
  },
  useMemo: (get: () => unknown) => get(),
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = harness.cursor++;
    const previous = harness.slots[i] as unknown[] | undefined;
    if (!previous || deps.some((dep, j) => !Object.is(dep, previous[j]))) {
      harness.slots[i] = deps;
      harness.effects.push(effect);
    }
  },
}));
vi.mock("@codemirror/view", async (original) => {
  const actual = await original<typeof import("@codemirror/view")>();
  class View {
    state: EditorState;
    constructor(config: Parameters<typeof EditorState.create>[0]) {
      this.state = EditorState.create(config);
      harness.views.push(this);
    }
    dispatch(spec: TransactionSpec) {
      const transaction = this.state.update(spec);
      this.state = transaction.state;
      const update = { startState: transaction.startState, state: this.state, docChanged: transaction.docChanged, transactions: [transaction] };
      for (const listener of this.state.facet(actual.EditorView.updateListener)) {
        listener(update as unknown as Parameters<typeof listener>[0]);
      }
    }
    destroy() {}
  }
  Object.setPrototypeOf(View, actual.EditorView);
  return { ...actual, EditorView: View };
});
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../extensions/language-extension", () => { const extension: [] = []; return { getLanguageExtension: () => extension }; });
vi.mock("../extensions/minimap", () => ({ minimap: () => [] }));
vi.mock("../extensions/custom-setup", () => ({ customSetup: [] }));
vi.mock("../extensions/suggestion", () => ({ suggestion: () => [] }));
vi.mock("../extensions/quick-edit", () => ({ quickEdit: () => [] }));
vi.mock("../extensions/selection-tooltip", () => ({ selectionTooltip: () => [] }));
vi.mock("@replit/codemirror-indentation-markers", () => ({ indentationMarkers: () => [] }));

import { CodeEditor } from "./code-editor";

function render(initialValue: string, onChange: (value: string) => void) {
  harness.cursor = 0;
  const element = CodeEditor({ fileName: "booking.tsx", initialValue, onChange });
  element.props.ref.current = {};
  harness.effects.splice(0).forEach((effect) => effect());
  return harness.views[0];
}
afterEach(() => { harness.slots = []; harness.views = []; harness.effects = []; vi.unstubAllGlobals(); });

test("an open clean editor follows newer agent content without remounting or emitting a save (#581)", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const onChange = vi.fn();
  const view = render("Book a meeting with Alex", onChange);
  view.dispatch({ selection: { anchor: 5 } });
  render("Choose a time with Alex Rivera", onChange);

  expect(view.state.doc.toString()).toBe("Choose a time with Alex Rivera");
  expect(harness.views).toHaveLength(1);
  expect(onChange).not.toHaveBeenCalled();
});

test("later local edits call the current save handler after a remote refresh", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const oldHandler = vi.fn();
  const nextHandler = vi.fn();
  const view = render("heading", oldHandler);
  render("new heading", nextHandler);
  view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
  expect(nextHandler).toHaveBeenCalledWith("new heading!", "new heading");
  expect(oldHandler).not.toHaveBeenCalled();
});

test("remote edits map the existing cursor and retain undo history for local edits", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const { history, undo } = await import("@codemirror/commands");
  const { StateEffect } = await import("@codemirror/state");
  const onChange = vi.fn();
  const view = render("header\nbody", onChange);
  view.dispatch({ effects: StateEffect.appendConfig.of(history()), selection: { anchor: 9 } });
  view.dispatch({ changes: { from: 11, insert: "!" } });
  render("new header\nbody!", onChange);
  expect(view.state.selection.main.head).toBe(13);
  const dispatch = view.dispatch.bind(view);
  undo({ state: view.state, dispatch });
  expect(view.state.doc.toString()).toBe("new header\nbody");
});

test("a keystroke serializes the document once (#605)", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const onChange = vi.fn();
  const view = render("heading", onChange);
  const toString = vi.spyOn(Text.prototype, "toString");
  view.dispatch({ changes: { from: 7, insert: "!" } });
  expect(toString).toHaveBeenCalledTimes(1);
  toString.mockRestore();
  expect(onChange).toHaveBeenCalledWith("heading!", "heading");
});

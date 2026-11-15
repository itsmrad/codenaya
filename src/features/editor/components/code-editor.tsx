import { useEffect, useMemo, useRef, useState } from "react"
import { EditorView, keymap } from "@codemirror/view";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { useTheme } from "next-themes";
import { oneDark } from "@codemirror/theme-one-dark";
import { indentWithTab } from "@codemirror/commands";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

import { minimap } from "../extensions/minimap";
import { customTheme, darkCursorTheme, lightTheme } from "../extensions/theme";
import { getLanguageExtension } from "../extensions/language-extension";
import { customSetup } from "../extensions/custom-setup";
import { suggestion } from "../extensions/suggestion";
import { quickEdit } from "../extensions/quick-edit";
import { selectionTooltip } from "../extensions/selection-tooltip";

// Below this width the minimap takes too much of the code area.
const MINIMAP_MIN_EDITOR_WIDTH = 600;
const externalContent = Annotation.define<boolean>();

export const editorTheme = (resolvedTheme?: string) =>
  resolvedTheme === "light" ? lightTheme : [oneDark, darkCursorTheme];

interface Props {
  fileName: string;
  initialValue?: string;
  onChange?: (value: string, previousValue: string) => void;
  /** Viewing only (a share link, #260): no edits and no AI actions, which act on the viewer's own project. */
  readOnly?: boolean;
}

export const CodeEditor = ({ 
  fileName, 
  initialValue = "",
  onChange,
  readOnly = false,
}: Props) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const [themeCompartment] = useState(() => new Compartment());
  const { resolvedTheme } = useTheme();

  const languageExtension = useMemo(() => {
    return getLanguageExtension(fileName)
  }, [fileName])

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!editorRef.current) return;

    const view = new EditorView({
      doc: initialValue,
      parent: editorRef.current,
      extensions: [
        themeCompartment.of(editorTheme(resolvedTheme)),
        customTheme,
        customSetup,
        languageExtension,
        readOnly
          ? EditorState.readOnly.of(true)
          : [suggestion(fileName), quickEdit(), selectionTooltip(fileName), keymap.of([indentWithTab])],
        minimap(),
        indentationMarkers(),
        EditorView.contentAttributes.of({ "aria-label": `Editor: ${fileName}` }),
        EditorView.updateListener.of((update) => {
          if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(externalContent))) {
            onChangeRef.current?.(update.state.doc.toString(), update.startState.doc.toString());
          }
        })
      ],
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialValue and resolvedTheme only seed the new view
  }, [languageExtension]);

  // The caller retains dirty drafts; only accepted content reaches this prop (#581).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const before = view.state.doc.toString();
    if (before === initialValue) return;
    let from = 0;
    let end = before.length;
    let nextEnd = initialValue.length;
    while (from < end && from < nextEnd && before[from] === initialValue[from]) from++;
    while (end > from && nextEnd > from && before[end - 1] === initialValue[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    view.dispatch({
      changes: { from, to: end, insert: initialValue.slice(from, nextEnd) },
      annotations: [externalContent.of(true), Transaction.addToHistory.of(false)],
    });
  }, [initialValue]);

  // Re-theme the open editor when the app theme changes, without recreating it.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(resolvedTheme)),
    });
  }, [resolvedTheme, themeCompartment]);

  // Hide the minimap on narrow editors. A ResizeObserver rather than a CSS
  // container query, because container queries would make this element the
  // containing block for CodeMirror's fixed-position tooltips.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      el.toggleAttribute(
        "data-narrow",
        entry.contentRect.width < MINIMAP_MIN_EDITOR_WIDTH,
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    // `isolate` keeps CodeMirror's z-index 500 tooltips (quick edit, selection
    // actions) inside the editor's stacking context, so dialogs and popovers
    // stack above them. `!` because CodeMirror's unlayered styles beat Tailwind's.
    <div
      ref={editorRef}
      className="isolate size-full pl-4 bg-background data-narrow:[&_.cm-minimap-gutter]:hidden!"
    />
  );
};

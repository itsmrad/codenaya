import { useEffect, useMemo, useRef, useState } from "react"
import { EditorView, keymap } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { useTheme } from "next-themes";
import { oneDark } from "@codemirror/theme-one-dark";
import { indentWithTab } from "@codemirror/commands";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

import { minimap } from "../extensions/minimap";
import { customTheme, lightTheme } from "../extensions/theme";
import { getLanguageExtension } from "../extensions/language-extension";
import { customSetup } from "../extensions/custom-setup";
import { suggestion } from "../extensions/suggestion";
import { quickEdit } from "../extensions/quick-edit";
import { selectionTooltip } from "../extensions/selection-tooltip";

// Below this width the minimap takes too much of the code area.
const MINIMAP_MIN_EDITOR_WIDTH = 600;

const editorTheme = (resolvedTheme?: string) =>
  resolvedTheme === "light" ? lightTheme : oneDark;

interface Props {
  fileName: string;
  initialValue?: string;
  onChange: (value: string) => void;
}

export const CodeEditor = ({ 
  fileName, 
  initialValue = "",
  onChange
}: Props) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [themeCompartment] = useState(() => new Compartment());
  const { resolvedTheme } = useTheme();

  const languageExtension = useMemo(() => {
    return getLanguageExtension(fileName)
  }, [fileName])

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
        suggestion(fileName),
        quickEdit(fileName),
        selectionTooltip(fileName),
        keymap.of([indentWithTab]),
        minimap(),
        indentationMarkers(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        })
      ],
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialValue and resolvedTheme only seed the new view
  }, [languageExtension]);

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

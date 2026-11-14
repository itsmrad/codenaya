import { useEffect, useRef } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useTheme } from "next-themes";

import { getLanguageExtension } from "../extensions/language-extension";
import { customTheme } from "../extensions/theme";
import { editorTheme } from "./code-editor";

interface Props {
  fileName: string;
  before: string;
  after: string;
}

/** Read-only unified diff of one file, styled like the code editor (#225). */
export const DiffViewer = ({ fileName, before, after }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const view = new EditorView({
      doc: after,
      parent: ref.current,
      extensions: [
        editorTheme(resolvedTheme),
        customTheme,
        lineNumbers(),
        getLanguageExtension(fileName),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: {} }),
        EditorView.contentAttributes.of({ "aria-label": `Changes to ${fileName}` }),
      ],
    });
    return () => view.destroy();
  }, [fileName, before, after, resolvedTheme]);

  return <div ref={ref} data-slot="diff-viewer" className="isolate size-full bg-background" />;
};

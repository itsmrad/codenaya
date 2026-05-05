import { EditorView } from "@codemirror/view";

export const customTheme = EditorView.theme({
  "&": {
    outline: "none !important",
    height: "100%",
    backgroundColor: "transparent !important",
  },
  ".cm-gutters": {
    backgroundColor: "transparent !important",
    backdropFilter: "blur(2px)",
    borderRight: "none",
  },
  ".cm-content": {
    fontFamily: "var(--font-nerd-mono), monospace",
    fontSize: "14px",
  },
  ".cm-scroller": {
    scrollbarWidth: "thin",
    scrollbarColor: "#3f3f46 transparent",
  },
})
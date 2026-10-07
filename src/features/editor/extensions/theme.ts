import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

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
  // Tooltips (selection actions, quick edit, autocomplete) use the app's popover tokens.
  ".cm-tooltip": {
    backgroundColor: "var(--popover) !important",
    color: "var(--popover-foreground) !important",
    border: "1px solid var(--input) !important",
  },
})

// One Dark's palette, darkened for light backgrounds: every token colour
// reaches WCAG AA (>= 4.5:1) on the app background, active line and selection.
const ink = "#383a42",
  stone = "#5f626c",
  coral = "#b02f37",
  malibu = "#2c58bb",
  whiskey = "#9c4800",
  chalky = "#7a5c00",
  cyan = "#0b6a83",
  sage = "#2f6f1c",
  violet = "#a0229e",
  invalid = "#c4001a",
  cursor = "#2563eb",
  selection = "#dce5f5",
  highlight = "#efebe5";

const lightEditorTheme = EditorView.theme({
  "&": { color: ink },
  ".cm-content": { caretColor: cursor },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: selection,
  },
  ".cm-panels": { backgroundColor: highlight, color: ink },
  ".cm-searchMatch": { backgroundColor: "#f5d76e66", outline: "1px solid #c9a227" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#f5d76e33" },
  ".cm-activeLine": { backgroundColor: "#7a5c0010" },
  ".cm-selectionMatch": { backgroundColor: "#2f6f1c1a" },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "#2c58bb26",
  },
  ".cm-gutters": { color: stone, border: "none" },
  ".cm-activeLineGutter": { backgroundColor: highlight },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: stone },
  ".cm-tooltip-autocomplete": {
    "& > ul > li[aria-selected]": { backgroundColor: highlight, color: ink },
  },
}, { dark: false });

// Same tag-to-colour mapping as One Dark, so code reads alike in both themes.
const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: violet },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: coral },
  { tag: [tags.function(tags.variableName), tags.labelName], color: malibu },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: whiskey },
  { tag: [tags.definition(tags.name), tags.separator], color: ink },
  {
    tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
    color: chalky,
  },
  {
    tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
    color: cyan,
  },
  { tag: [tags.meta, tags.comment], color: stone },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: stone, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: coral },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: whiskey },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: sage },
  { tag: tags.invalid, color: invalid },
]);

export const lightTheme = [lightEditorTheme, syntaxHighlighting(lightHighlightStyle)];

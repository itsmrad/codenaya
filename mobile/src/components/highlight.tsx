import Prism from "prismjs";
// Each adds its grammar to the global Prism; jsx and tsx need the ones before them.
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import type { ReactNode } from "react";
import { Text } from "react-native";

import type { Colors } from "@/lib/theme";

/** The Prism grammar for each file extension. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  html: "markup",
  svg: "markup",
  xml: "markup",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  sql: "sql",
};

/** Larger files stay plain: one Text per token would slow the screen. */
const MAX_HIGHLIGHT = 100_000;

/** Token colours, like the web editor's: Prism's token types onto the theme. */
const palette = (c: Colors): Record<string, string> => ({
  comment: c.mutedForeground,
  prolog: c.mutedForeground,
  doctype: c.mutedForeground,
  cdata: c.mutedForeground,
  string: c.success,
  char: c.success,
  regex: c.success,
  url: c.success,
  "attr-value": c.success,
  inserted: c.success,
  keyword: c.brandText,
  tag: c.brandText,
  selector: c.brandText,
  atrule: c.brandText,
  important: c.brandText,
  deleted: c.destructive,
  function: "#3b82f6",
  "class-name": "#3b82f6",
  builtin: "#3b82f6",
  "attr-name": "#8b5cf6",
  property: "#8b5cf6",
  number: c.brand,
  boolean: c.brand,
  constant: c.brand,
  symbol: c.brand,
});

function render(stream: Prism.TokenStream, colors: Record<string, string>, key: string): ReactNode {
  if (typeof stream === "string") return stream;
  if (Array.isArray(stream)) return stream.map((token, index) => render(token, colors, `${key}.${index}`));
  const aliases = typeof stream.alias === "string" ? [stream.alias] : (stream.alias ?? []);
  const color = colors[stream.type] ?? aliases.map((alias) => colors[alias]).find(Boolean);
  // Uncoloured tokens (punctuation, operators) inherit the code's colour.
  return (
    <Text key={key} style={color ? { color } : undefined}>
      {render(stream.content, colors, key)}
    </Text>
  );
}

/** The file's code as coloured spans for a parent Text, or plain for other files. */
export function highlight(code: string, fileName: string, c: Colors): ReactNode {
  const grammar = Prism.languages[LANGUAGES[fileName.split(".").pop()!.toLowerCase()]];
  if (!grammar || code.length > MAX_HIGHLIGHT) return code;
  return render(Prism.tokenize(code, grammar), palette(c), "t");
}

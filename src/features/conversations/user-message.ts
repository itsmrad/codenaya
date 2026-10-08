/** A run of a user message: prose, or a pasted log / code to show verbatim. */
export interface UserMessageBlock {
  kind: "text" | "code";
  text: string;
}

// Lines that read as code or tool output rather than prose: indented lines,
// code frames (`3 | import …`, `  | ^`), stack frames, `path:line` locations,
// statements and lines ending in code punctuation.
const CODE_LINE =
  /^(\s{2,}\S|\s*\d*\s*\|\s|\s*at\s|\s*(import|export|const|let|var|function|return)\b)|^\S*\/\S+:\d+|[{};]\s*$/;

const isCodeParagraph = (lines: string[]) =>
  lines.length >= 3 &&
  lines.filter((line) => CODE_LINE.test(line)).length * 2 >= lines.length;

/**
 * Splits a user message so pasted logs and code render as monospace blocks:
 * fenced (```) blocks, and paragraphs that are mostly code-like lines.
 */
export const userMessageBlocks = (content: string): UserMessageBlock[] => {
  const blocks: UserMessageBlock[] = [];
  const push = (kind: UserMessageBlock["kind"], text: string) => {
    const previous = blocks.at(-1);
    if (kind === "text" && previous?.kind === "text") {
      previous.text = `${previous.text}\n\n${text}`;
    } else {
      blocks.push({ kind, text });
    }
  };

  const fenced = content.split(/^```[^\n]*$/m);
  fenced.forEach((part, index) => {
    // Odd parts sit between fences.
    if (index % 2 === 1) {
      const code = part.replace(/^\n|\n$/g, "");
      if (code) push("code", code);
      return;
    }
    for (const paragraph of part.split(/\n\s*\n/)) {
      const text = paragraph.replace(/^\n+|\s+$/g, "");
      if (!text) continue;
      push(isCodeParagraph(text.split("\n")) ? "code" : "text", text);
    }
  });
  return blocks;
};

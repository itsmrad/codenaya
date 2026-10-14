// CSI sequences (colours, cursor moves, line clears) and OSC titles/links.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// The output buffer grows for the whole session; the last line is in its tail.
const TAIL_LENGTH = 4096;

/**
 * The last visible line of raw terminal output, without escape codes, for a
 * one-line summary. A carriage return rewrites the line in a terminal (spinners,
 * progress bars), so only the text after the last one counts.
 */
export const lastLogLine = (output: string): string => {
  const lines = output.slice(-TAIL_LENGTH).replace(ANSI_PATTERN, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
      .split("\r")
      .findLast((segment) => segment.trim())
      ?.trim();
    if (line) return line;
  }
  return "";
};

/**
 * Utility functions for the preview log viewer.
 */

/**
 * Returns the sliced output string after taking `clearedOffset` into account.
 * If the preview has restarted (indicated by output length being less than the offset),
 * the cleared offset is ignored and full output is returned.
 */
export function sliceClearedOutput(output: string, clearedOffset: number): string {
  if (clearedOffset <= 0) return output;
  if (output.length < clearedOffset) return output;
  return output.slice(clearedOffset);
}

/**
 * Checks whether the cleared offset should be reset to 0 (e.g. after a preview restart).
 */
export function shouldResetClearedOffset(outputLength: number, clearedOffset: number): boolean {
  return clearedOffset > 0 && outputLength < clearedOffset;
}

/**
 * Normalizes buffer lines into plain text, stripping trailing blank lines.
 */
export function normalizeBufferText(lines: string[]): string {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") {
    copy.pop();
  }
  return copy.join("\n");
}

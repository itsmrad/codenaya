/**
 * Composer voice dictation (#301), the parts that don't need a browser:
 * where a final transcript goes and which key toggles it.
 */

/** Recording stops after this long without speech. */
export const DICTATION_SILENCE_MS = 60_000;

/**
 * `value` with `transcript` in place of the selection (the cursor when
 * nothing is selected), spaced from the text around it. Typed text is kept.
 */
export const insertTranscript = (
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): { value: string; caret: number } => {
  const text = transcript.trim();
  if (!text) return { value, caret: selectionEnd };
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + text + trail;
  return { value: before + inserted + after, caret: before.length + inserted.length };
};

/** Alt+V (Option+V on macOS); `code`, since Option+V types "√" as its key. */
export const isDictationKey = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code">,
): boolean =>
  event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyV";

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

/**
 * What to tell the user when recognition fails; null for "aborted", which is
 * our own cancel. Codes from the Web Speech API's SpeechRecognitionErrorEvent.
 */
export const dictationErrorMessage = (code: string): string | null => {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it in your browser to dictate.";
    case "no-speech":
      return "No speech heard, so dictation stopped.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Dictation needs a network connection.";
    default:
      return "Dictation stopped unexpectedly.";
  }
};

/** Alt+V (Option+V on macOS); `code`, since Option+V types "√" as its key. */
export const isDictationKey = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code">,
): boolean =>
  event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyV";

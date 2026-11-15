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

/**
 * Languages the server transcription model (parakeet-tdt-0.6b-v3) knows, as
 * ISO 639-1 codes. Any other language dictates with the browser's speech
 * recognition instead.
 */
export const SERVER_DICTATION_LANGUAGES = [
  "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it",
  "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk",
] as const;

/** More languages the picker offers, which only the browser can dictate. */
export const BROWSER_DICTATION_LANGUAGES = ["ar", "hi", "id", "ja", "ko", "tr", "vi", "zh"] as const;

/** The picker's default: the server model detects the language itself. */
export const DICTATION_AUTO = "auto";

/** "pt-BR" → "pt". */
const baseLanguage = (tag: string) => tag.toLowerCase().split("-")[0] ?? "";

export const isServerDictationLanguage = (tag: string): boolean =>
  (SERVER_DICTATION_LANGUAGES as readonly string[]).includes(baseLanguage(tag));

export type DictationRoute =
  /** Record and transcribe on the server; `language` is a hint, absent on Auto. */
  | { engine: "server"; language?: string }
  /** The browser's speech recognition, which needs one language. */
  | { engine: "browser"; lang: string };

/**
 * Who dictates: the server when it knows the language (on Auto, the browser's
 * own), else the browser's speech recognition. Null when neither is there.
 * Without browser recognition the server tries anyway: it detects the language.
 */
export function dictationRouteOrNull({
  picked,
  browserLanguage,
  canRecord,
  canRecognize,
}: {
  picked: string;
  browserLanguage: string;
  canRecord: boolean;
  canRecognize: boolean;
}): DictationRoute | null {
  const auto = picked === DICTATION_AUTO;
  const lang = auto ? browserLanguage : picked;
  if (canRecord && (isServerDictationLanguage(lang) || !canRecognize)) {
    return auto ? { engine: "server" } : { engine: "server", language: baseLanguage(picked) };
  }
  return canRecognize ? { engine: "browser", lang } : null;
}

/** A failed `/api/transcribe` answer in plain words. */
export const transcribeErrorMessage = (status: number, serverMessage?: string): string => {
  if (status === 402) return serverMessage ?? "Out of credits.";
  if (status === 413) return "That recording is too long. Try a shorter one.";
  if (status === 429) return "Too many dictations at once. Wait a moment and try again.";
  return "Transcription failed, try again.";
};

/** getUserMedia's DOMException names, as the speech recognition codes above. */
export const recorderErrorCode = (error: unknown): string => {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "not-allowed";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "audio-capture";
  return "unknown";
};

/** A project note: a lasting preference or correction the owner saved (#630). */
export type ProjectNote = { id: string; text: string; createdAt: number };

/** Most notes a project may store. */
export const MAX_PROJECT_NOTES = 50;
/** Longest single note. */
export const MAX_PROJECT_NOTE_LENGTH = 300;
/** Shown, and thrown by the backend, when a note holds a credential. */
export const NOTE_CREDENTIAL_ERROR =
  "Notes can't hold credentials. Remove the secret and add the connection through Integrations instead.";
/** Most notes, and characters, that go into a run's prompt. */
export const MAX_PROMPT_NOTES = 20;
export const MAX_PROMPT_NOTES_CHARS = 2000;

/**
 * The notes a run sees, oldest first: the newest that fit in
 * MAX_PROMPT_NOTES and MAX_PROMPT_NOTES_CHARS, so the oldest drop first.
 */
export function capNotesForPrompt(notes: readonly ProjectNote[] = []): string[] {
  const kept: string[] = [];
  let chars = 0;
  const newestFirst = [...notes].sort((a, b) => b.createdAt - a.createdAt);
  for (const note of newestFirst) {
    const text = note.text.trim();
    if (!text) continue;
    if (kept.length === MAX_PROMPT_NOTES || chars + text.length > MAX_PROMPT_NOTES_CHARS) break;
    kept.push(text);
    chars += text.length;
  }
  return kept.reverse();
}

// shortcut: a keyword heuristic, no model call; swap for a classifier if it
// proposes too often or misses real corrections.
const LASTING_PREFERENCE =
  /\bremember that\b|\b(?:don['’]?t|do not|stop|always|never)\b[^.!?\n]*\bagain\b/i;

/**
 * Whether a user message reads like a lasting preference or correction worth
 * proposing as a note: a follow-up, short, one paragraph, with correction phrasing.
 */
export function looksLikeLastingPreference(text: string, hasPriorMessages: boolean): boolean {
  const trimmed = text.trim();
  return (
    hasPriorMessages &&
    trimmed.length >= 8 &&
    trimmed.length <= MAX_PROJECT_NOTE_LENGTH &&
    !trimmed.includes("\n\n") &&
    !trimmed.startsWith("/") &&
    LASTING_PREFERENCE.test(trimmed)
  );
}

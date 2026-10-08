/**
 * A prompt typed while signed out, kept across the sign-up redirect so the
 * dashboard can create the project from it once the user is signed in.
 * Storage can be unavailable (private mode, blocked site data), so every
 * access is best-effort.
 */
export const PENDING_PROMPT_KEY = "codenaya:pendingPrompt";

export const savePendingPrompt = (prompt: string) => {
  try {
    localStorage.setItem(PENDING_PROMPT_KEY, prompt);
  } catch {
    // Without storage the prompt is simply not resumed.
  }
};

/** Returns the saved prompt at most once: reading it also clears it. */
export const takePendingPrompt = (): string | null => {
  try {
    const prompt = localStorage.getItem(PENDING_PROMPT_KEY);
    localStorage.removeItem(PENDING_PROMPT_KEY);
    return prompt?.trim() || null;
  } catch {
    return null;
  }
};

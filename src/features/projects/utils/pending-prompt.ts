import { PLAN_MODE, SWARM_MODE, type MessageMode } from "@/features/conversations/plan-mode";

/**
 * A prompt typed while signed out, kept across the sign-up redirect so the
 * dashboard can create the project from it once the user is signed in.
 * Storage can be unavailable (private mode, blocked site data), so every
 * access is best-effort.
 */
export const PENDING_PROMPT_KEY = "codenaya:pendingPrompt";

export interface PendingPrompt {
  prompt: string;
  /** Omitted means build. */
  mode?: MessageMode;
}

const isMode = (value: unknown): value is MessageMode => value === PLAN_MODE || value === SWARM_MODE;

/** A build prompt stays a plain string, as stored before modes; another mode is kept as JSON. */
export const savePendingPrompt = (prompt: string, mode?: MessageMode) => {
  try {
    localStorage.setItem(PENDING_PROMPT_KEY, mode ? JSON.stringify({ prompt, mode }) : prompt);
  } catch {
    // Without storage the prompt is simply not resumed.
  }
};

const parse = (raw: string | null): PendingPrompt | null => {
  if (!raw) return null;
  let saved: PendingPrompt = { prompt: raw };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && typeof (value as PendingPrompt).prompt === "string") {
      const { prompt, mode } = value as PendingPrompt;
      saved = { prompt, ...(isMode(mode) ? { mode } : {}) };
    }
  } catch {
    // A plain prompt.
  }
  const prompt = saved.prompt.trim();
  return prompt ? { ...saved, prompt } : null;
};

/** The saved prompt, left in place: the auth pages show it before sign-up (#252). */
export const peekPendingPrompt = (): string | null => {
  try {
    return parse(localStorage.getItem(PENDING_PROMPT_KEY))?.prompt ?? null;
  } catch {
    return null;
  }
};

/** Returns the saved prompt and its mode at most once: reading it also clears it. */
export const takePendingPrompt = (): PendingPrompt | null => {
  try {
    const saved = parse(localStorage.getItem(PENDING_PROMPT_KEY));
    localStorage.removeItem(PENDING_PROMPT_KEY);
    return saved;
  } catch {
    return null;
  }
};

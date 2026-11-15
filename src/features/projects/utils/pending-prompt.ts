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

let draftRevision = 0;

const isMode = (value: unknown): value is MessageMode => value === PLAN_MODE || value === SWARM_MODE;

/** A build prompt stays a plain string, as stored before modes; another mode is kept as JSON. */
export const savePendingPrompt = (prompt: string, mode?: MessageMode) => {
  try {
    localStorage.setItem(PENDING_PROMPT_KEY, mode ? JSON.stringify({ prompt, mode }) : prompt);
    draftRevision++;
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

// Shared across effect replays and dashboard remounts while a request is pending.
let isResuming = false;

/** Keep the draft until creation succeeds; null means there was nothing to attempt. */
export const resumePendingPrompt = async (
  create: (pending: PendingPrompt) => Promise<boolean>,
): Promise<boolean | null> => {
  if (isResuming) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_PROMPT_KEY);
  } catch {
    return null;
  }
  const pending = parse(raw);
  if (!pending) return null;

  const revision = draftRevision;
  isResuming = true;
  try {
    if (!(await create(pending))) return false;
    try {
      // A draft saved during the request belongs to a later submission.
      if (draftRevision === revision && localStorage.getItem(PENDING_PROMPT_KEY) === raw) {
        localStorage.removeItem(PENDING_PROMPT_KEY);
      }
    } catch {
      // Storage remains best-effort, even after a successful creation.
    }
    return true;
  } catch {
    return false;
  } finally {
    isResuming = false;
  }
};

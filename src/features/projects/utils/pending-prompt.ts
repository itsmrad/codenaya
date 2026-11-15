import { isProjectFramework, type ProjectFramework } from "./project-framework";
import { readPendingStart, savePendingStart } from "@/lib/pending-intent";
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
  framework?: ProjectFramework;
}

let draftRevision = 0;

const isMode = (value: unknown): value is MessageMode => value === PLAN_MODE || value === SWARM_MODE;

/** Keep the mode with the draft; a re-save (a failed retry) renews its one-hour window. */
export const savePendingPrompt = (prompt: string, mode?: MessageMode, framework?: ProjectFramework) => {
  try {
    savePendingStart(PENDING_PROMPT_KEY, prompt, { mode, framework });
    draftRevision++;
  } catch {
    // Without storage the prompt is simply not resumed.
  }
};

/** Drops the saved prompt, for a draft that can never be created as written. */
export const clearPendingPrompt = () => {
  try {
    localStorage.removeItem(PENDING_PROMPT_KEY);
  } catch {
    // Best-effort, like every other storage access.
  }
};

/** A pre-envelope entry is a bare prompt, or the JSON {prompt, mode, framework} older builds wrote. */
const unwrapLegacy = (raw: string) => {
  try {
    const old: unknown = JSON.parse(raw);
    if (old && typeof old === "object" && typeof (old as PendingPrompt).prompt === "string") {
      const { prompt, mode, framework } = old as PendingPrompt;
      return { value: prompt, mode: isMode(mode) ? mode : undefined, framework: isProjectFramework(framework) ? framework : undefined };
    }
  } catch {
    // A plain prompt.
  }
  return { value: raw };
};

/** The full saved draft, without consuming or renewing it. */
export const peekPendingPromptDraft = (): PendingPrompt | null => {
  try {
    const saved = readPendingStart(PENDING_PROMPT_KEY, unwrapLegacy);
    const prompt = saved?.value.trim();
    if (!saved || !prompt) return null;
    return {
      prompt,
      ...(isMode(saved.mode) ? { mode: saved.mode } : {}),
      ...(isProjectFramework(saved.framework) ? { framework: saved.framework } : {}),
    };
  } catch {
    return null;
  }
};

/** The auth pages show the saved prompt before sign-up (#252). */
export const peekPendingPrompt = (): string | null => peekPendingPromptDraft()?.prompt ?? null;

// Shared across effect replays and dashboard remounts while a request is pending.
let isResuming = false;
// Bumped on a user change: a resume of the previous user can't release the next user's lock or draft.
let resumeEpoch = 0;

export const resetPendingPromptResume = () => {
  resumeEpoch++;
  isResuming = false;
};

/** Keep the draft until creation succeeds; null means there was nothing to attempt. */
export const resumePendingPrompt = async (
  create: (pending: PendingPrompt) => Promise<boolean>,
): Promise<boolean | null> => {
  if (isResuming) return null;
  let raw: string | null;
  try {
    // Migrate/validate before capturing the envelope for the concurrency check.
    if (!readPendingStart(PENDING_PROMPT_KEY, unwrapLegacy)) return null;
    raw = localStorage.getItem(PENDING_PROMPT_KEY);
  } catch {
    return null;
  }
  const pending = peekPendingPromptDraft();
  if (!pending) return null;

  const revision = draftRevision;
  const epoch = resumeEpoch;
  isResuming = true;
  try {
    if (!(await create(pending))) return false;
    try {
      // A draft saved during the request belongs to a later submission.
      if (draftRevision === revision && epoch === resumeEpoch && localStorage.getItem(PENDING_PROMPT_KEY) === raw) {
        localStorage.removeItem(PENDING_PROMPT_KEY);
      }
    } catch {
      // Storage remains best-effort, even after a successful creation.
    }
    return true;
  } catch {
    return false;
  } finally {
    if (epoch === resumeEpoch) isResuming = false;
  }
};

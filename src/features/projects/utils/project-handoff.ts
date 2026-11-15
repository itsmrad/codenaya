import { toast } from "sonner";
import { peekPendingTemplate } from "@/features/templates/utils/pending-template";
import type { StarterTemplateId } from "@/features/templates/templates";
import { peekPendingPromptDraft, resetPendingPromptResume, type PendingPrompt } from "./pending-prompt";

/** A template start keeps its id, so a recovered retry still creates from the template. */
export type HandoffDraft = PendingPrompt & { templateId?: StarterTemplateId };

type Handoff = {
  phase: "loading" | "idle" | "creating" | "navigating";
  draft: HandoffDraft | null;
};
const LOADING: Handoff = { phase: "loading", draft: null };
const IDLE: Handoff = { phase: "idle", draft: null };
let handoff = LOADING;
let attempt: Promise<boolean> | null = null;
// Bumped when the signed-in user changes, so an attempt of the previous user can't touch the store.
let generation = 0;
/** The persistent "saved, try again" toast of the sign-up resume. */
export const PENDING_RETRY_TOAST_ID = "pending-prompt-retry";
const listeners = new Set<() => void>();

/**
 * The dashboard can be hidden and reshown without unmounting (Next's Activity),
 * so the snapshot is derived from storage whenever no attempt or recovered draft
 * owns the screen: it shows the loading shell only while a handoff is pending.
 */
export const getProjectHandoff = (): Handoff => {
  if (!attempt && !handoff.draft && handoff.phase !== "navigating" && typeof window !== "undefined") {
    handoff = peekPendingPromptDraft() || peekPendingTemplate() ? LOADING : IDLE;
  }
  return handoff;
};
/** Changes on every user change; a create started under an older one must not act on the next user's screen. */
export const getProjectGeneration = () => generation;
export const getServerProjectGeneration = () => 0;
export const isCurrentProjectGeneration = (started: number) => started === generation;
export const getServerProjectHandoff = () => LOADING;
const publish = (next: Handoff) => {
  handoff = next;
  listeners.forEach((listener) => listener());
};

export const subscribeProjectHandoff = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // Strict Mode resubscribes synchronously; a hidden dashboard must not come back on a finished handoff.
    queueMicrotask(() => {
      if (!listeners.size && !attempt && handoff.phase === "navigating") handoff = IDLE;
    });
  };
};

/** Forgets the recovered draft and any attempt in flight: the next user must not see the last one's prompt. */
export const resetProjectHandoff = () => {
  generation++;
  attempt = null;
  resetPendingPromptResume();
  toast.dismiss(PENDING_RETRY_TOAST_ID);
  publish(IDLE);
};

/** One attempt owns the screen, including across Retry clicks and dashboard remounts. */
export const runProjectHandoff = (
  draft: HandoffDraft,
  create: () => Promise<boolean>,
  recover: () => HandoffDraft | null = () => draft,
): Promise<boolean> => {
  if (attempt) return attempt;
  publish({ phase: "creating", draft });
  const mine = generation;
  let created = false;
  const run: Promise<boolean> = Promise.resolve().then(create).then((result) => {
    created = result;
    return result;
  }).catch(() => false).finally(() => {
    if (mine !== generation) return;
    attempt = null;
    // Finished while hidden: nothing is left to navigate from.
    publish(created ? (listeners.size ? { phase: "navigating", draft } : IDLE) : { phase: "idle", draft: recover() });
  });
  attempt = run;
  return run;
};

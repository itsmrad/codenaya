/**
 * A Remix clicked while signed out, kept across the sign-up redirect so the
 * showcase page can finish it once the user is signed in. Storage can be
 * unavailable (private mode, blocked site data), so every access is
 * best-effort, like the pending prompt in `features/projects`.
 */
export const PENDING_REMIX_KEY = "codenaya:pendingIntent";

type PendingRemix = { kind: "remix"; showcaseId: string };

export const savePendingRemix = (showcaseId: string) => {
  try {
    const intent: PendingRemix = { kind: "remix", showcaseId };
    localStorage.setItem(PENDING_REMIX_KEY, JSON.stringify(intent));
  } catch {
    // Without storage the remix is simply not resumed.
  }
};

/** Returns the saved showcase id at most once: reading it also clears it. */
export const takePendingRemix = (): string | null => {
  try {
    const raw = localStorage.getItem(PENDING_REMIX_KEY);
    localStorage.removeItem(PENDING_REMIX_KEY);
    const intent = raw ? (JSON.parse(raw) as Partial<PendingRemix>) : null;
    return intent?.kind === "remix" && typeof intent.showcaseId === "string"
      ? intent.showcaseId
      : null;
  } catch {
    return null;
  }
};

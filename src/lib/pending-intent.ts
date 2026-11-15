/**
 * Something a signed-out visitor started (a Remix, an "Open in Codenaya"
 * import), kept across the sign-up redirect so it can be finished once they
 * are signed in. There is one slot: saving an intent replaces the last one.
 * Storage can be unavailable (private mode, blocked site data), so every
 * access is best-effort.
 */
export const PENDING_INTENT_KEY = "codenaya:pendingIntent";

export const savePendingIntent = (intent: { kind: string; [field: string]: string }) => {
  try {
    localStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Without storage the intent is simply not resumed.
  }
};

/**
 * Returns the saved intent if it is of `kind`, at most once: taking it clears
 * the slot. An intent of another kind is left for the page that owns it (the
 * dashboard mounts right after sign-in, before a Remix resumes on its page).
 */
export const takePendingIntent = (kind: string): Record<string, unknown> | null => {
  try {
    const raw = localStorage.getItem(PENDING_INTENT_KEY);
    const intent = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
    if (intent?.kind !== kind) return null;
    localStorage.removeItem(PENDING_INTENT_KEY);
    return intent;
  } catch {
    return null;
  }
};

/** Prompt/template handoffs expire an hour after saving, including failed retries. */
export const PENDING_START_MAX_AGE = 60 * 60 * 1000;

export interface PendingStart {
  value: string;
  savedAt: number;
  framework?: string;
  mode?: string;
}

export const savePendingStart = (
  key: string, value: string, choices: { framework?: string; mode?: string } = {},
) => {
  localStorage.setItem(key, JSON.stringify({ value, savedAt: Date.now(), ...choices }));
};

const plainLegacy = (raw: string) => ({ value: raw });

/**
 * Legacy entries get one bounded migration window; peeking never renews it.
 * `migrate` unwraps a pre-envelope entry; only those are ever read that way,
 * so a prompt that merely looks like JSON stays literal text.
 */
export const readPendingStart = (
  key: string,
  migrate: (raw: string) => { value: string; framework?: string; mode?: string } = plainLegacy,
): PendingStart | null => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    // Legacy plain string.
  }
  if (saved && typeof saved === "object" && ("value" in saved || "savedAt" in saved)) {
    if (!("savedAt" in saved) || typeof saved.savedAt !== "number" || !Number.isFinite(saved.savedAt) ||
        saved.savedAt > Date.now() || Date.now() - saved.savedAt > PENDING_START_MAX_AGE ||
        !("value" in saved) || typeof saved.value !== "string") {
      localStorage.removeItem(key);
      return null;
    }
    return {
      value: saved.value, savedAt: saved.savedAt,
      ...("framework" in saved && typeof saved.framework === "string" ? { framework: saved.framework } : {}),
      ...("mode" in saved && typeof saved.mode === "string" ? { mode: saved.mode } : {}),
    };
  }
  const { value, ...choices } = migrate(raw);
  savePendingStart(key, value, choices);
  return { value, savedAt: Date.now(), ...choices };
};

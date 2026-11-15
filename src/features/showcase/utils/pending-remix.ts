import { savePendingIntent, takePendingIntent } from "@/lib/pending-intent";

/**
 * A Remix clicked while signed out, kept across the sign-up redirect so the
 * page it came from (a showcase entry or a share link) can finish it once the
 * user is signed in. `source` is that page's path.
 */
export const savePendingRemix = (source: string) =>
  savePendingIntent({ kind: "remix", source });

/** Returns the saved source path at most once: reading it also clears it. */
export const takePendingRemix = (): string | null => {
  const source = takePendingIntent("remix")?.source;
  return typeof source === "string" ? source : null;
};

// Matches both control routes' maxDuration; expiry permits a read, never unlocks by itself.
export const CONTROL_WRITE_WINDOW_MS = 60_000;

/** Resuming renewal never proves payment or extends settled access. */
export function canUncancel(input: {
  deleted: boolean; held: boolean; renewable: boolean; cancelAt?: number; paidThrough?: number;
}, now: number): boolean {
  return !input.deleted && !input.held && input.renewable && input.cancelAt !== undefined &&
    input.paidThrough !== undefined && now < input.paidThrough;
}

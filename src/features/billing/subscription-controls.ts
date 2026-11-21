/** Resuming renewal never proves payment or extends settled access. */
export function canUncancel(input: {
  deleted: boolean; held: boolean; renewable: boolean; cancelAt?: number; paidThrough?: number;
}, now: number): boolean {
  return !input.deleted && !input.held && input.renewable && input.cancelAt !== undefined &&
    input.paidThrough !== undefined && now < input.paidThrough;
}

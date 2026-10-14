/**
 * Boot phases `POST /api/sandbox` reports as `{ type: "phase", phase, at }`
 * (#254), in order. `ready` follows the last step.
 */
export const BOOT_PHASES = ["create", "files", "install", "start", "ready"] as const;

export type BootPhase = (typeof BOOT_PHASES)[number];

export const isBootPhase = (value: unknown): value is BootPhase =>
  typeof value === "string" && (BOOT_PHASES as readonly string[]).includes(value);

export type BootHistory = Partial<Record<BootPhase, { at: number; logAt: number }>>;

/** Keep protocol timing and log boundaries even when React batches stream events. */
export const recordBootPhase = (
  history: BootHistory,
  phase: unknown,
  at: unknown,
  logAt: number,
): BootHistory => {
  if (!isBootPhase(phase) || typeof at !== "number" || !Number.isFinite(at) || at < 0)
    return history;
  if (history[phase]) return history;
  return { ...history, [phase]: { at, logAt } };
};

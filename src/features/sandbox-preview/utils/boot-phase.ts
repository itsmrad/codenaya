/**
 * Boot phases `POST /api/sandbox` reports as `{ type: "phase", phase, at }`
 * (#254), in order. `ready` follows the last step.
 */
export const BOOT_PHASES = ["create", "files", "install", "start", "ready"] as const;

export type BootPhase = (typeof BOOT_PHASES)[number];

export const isBootPhase = (value: unknown): value is BootPhase =>
  typeof value === "string" && (BOOT_PHASES as readonly string[]).includes(value);

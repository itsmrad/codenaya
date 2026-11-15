import { describe, expect, it } from "vitest";
import { readInstallFailure } from "./app-error";
import { isEsbuildServiceFailure, nextEsbuildRecovery, ESBUILD_RECOVERY_COOLDOWN_MS } from "./esbuild-recovery";

describe("esbuild service recovery (#776)", () => {
  it.each([
    "The service is no longer running: write EPIPE",
    "The service is no longer running",
    "The service was stopped",
    "write EPIPE",
  ])("recognizes the build error: %s", (message) => {
    expect(isEsbuildServiceFailure({ kind: "build", message }, "vite")).toBe(true);
  });

  it("recognizes an esbuild stack but leaves app and network failures alone", () => {
    expect(isEsbuildServiceFailure({ kind: "runtime", message: "write EPIPE", stack: "esbuild/lib/main.js:718" }, "vite")).toBe(true);
    for (const error of [
      null,
      { kind: "runtime" as const, message: "write EPIPE" },
      { kind: "build" as const, message: "Failed to resolve import './Missing'" },
      { kind: "build" as const, message: "npm error code ERESOLVE" },
    ]) expect(isEsbuildServiceFailure(error, "vite")).toBe(false);
  });

  it("ignores a package.json install failure that only mentions EPIPE", () => {
    const { error } = readInstallFailure({ installFailed: { exitCode: 1, code: "EPIPE" } }, "npm install")!;
    expect(error?.message).toContain("EPIPE");
    expect(isEsbuildServiceFailure(error!, "vite")).toBe(false);
  });

  it("only recovers a Vite project: Next and unknown frameworks never restart", () => {
    const error = { kind: "build" as const, message: "The service is no longer running: write EPIPE", stack: "esbuild/lib/main.js" };
    expect(isEsbuildServiceFailure(error, "vite")).toBe(true);
    expect(isEsbuildServiceFailure(error, "next")).toBe(false);
    expect(isEsbuildServiceFailure(error, null)).toBe(false);
  });

  it("allows one attempt per two minutes and at most three, including failures", () => {
    const first = nextEsbuildRecovery(undefined, 0)!;
    expect(first).toEqual({ attempts: 1, lastAttemptAt: 0 });
    expect(nextEsbuildRecovery(first, ESBUILD_RECOVERY_COOLDOWN_MS - 1)).toBeNull();
    const second = nextEsbuildRecovery(first, ESBUILD_RECOVERY_COOLDOWN_MS)!;
    const third = nextEsbuildRecovery(second, 2 * ESBUILD_RECOVERY_COOLDOWN_MS)!;
    expect(third.attempts).toBe(3);
    expect(nextEsbuildRecovery(third, 10 * ESBUILD_RECOVERY_COOLDOWN_MS)).toBeNull();
  });
});

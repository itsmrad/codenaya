import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../utils/app-error";
import { ESBUILD_RECOVERY_COOLDOWN_MS, type EsbuildRecoveryStatus } from "../utils/esbuild-recovery";

// Node has no DOM renderer: keep state and effect lifetimes across renders, as use-sandbox.test does.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const next = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  return {
    reset: () => { slots.forEach((slot) => slot.cleanup?.()); slots.length = 0; effects.length = 0; cursor = 0; },
    render: () => { cursor = 0; },
    commit: () => { effects.splice(0).forEach((effect) => effect()); },
    useState: (initial: unknown) => {
      const slot = next();
      if (!("value" in slot)) slot.value = initial;
      return [slot.value, (update: unknown) => { slot.value = update; }];
    },
    useRef: (initial: unknown) => {
      const slot = next();
      return slot.value ?? (slot.value = { current: initial });
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const slot = next();
      if (slot.deps && deps.every((dep, i) => Object.is(dep, slot.deps?.[i]))) return;
      slot.deps = deps;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    },
  };
});
vi.mock("react", () => hooks);
import { useEsbuildRecovery } from "./use-esbuild-recovery";

const error: AppError = { kind: "build", message: "The service is no longer running: write EPIPE", file: "esbuild/lib/main.js:718" };
const recover = vi.fn<() => Promise<EsbuildRecoveryStatus>>();
const render = (props: { error?: AppError | null } = {}) => {
  hooks.render();
  const result = useEsbuildRecovery({ sandboxId: "sbx", framework: "vite", error: "error" in props ? props.error! : error, recover });
  hooks.commit();
  return result;
};

beforeEach(() => { vi.useFakeTimers(); hooks.reset(); recover.mockReset(); });
afterEach(() => { hooks.reset(); vi.useRealTimers(); });

describe("useEsbuildRecovery (#776)", () => {
  it("waits out a busy install, then restarts once without spending an attempt on the wait", async () => {
    recover.mockResolvedValueOnce("busy").mockResolvedValueOnce("restarted");
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ESBUILD_RECOVERY_COOLDOWN_MS * 2);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("retries a failed request once after the cooldown", async () => {
    recover.mockRejectedValueOnce(new Error("502")).mockResolvedValueOnce("restarted");
    render();
    await vi.advanceTimersByTimeAsync(ESBUILD_RECOVERY_COOLDOWN_MS - 1);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("does not retry once the error is gone", async () => {
    recover.mockRejectedValueOnce(new Error("502"));
    render();
    await vi.advanceTimersByTimeAsync(0);
    render({ error: null });
    await vi.advanceTimersByTimeAsync(ESBUILD_RECOVERY_COOLDOWN_MS * 2);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

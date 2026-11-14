import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

// Node has no DOM renderer. Keep hook state and effect lifetimes across renders;
// fetch, timers and the complete useSandbox implementation run normally.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const next = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (slot: Slot, deps: unknown[]) =>
    !slot.deps || deps.some((dep, i) => !Object.is(dep, slot.deps?.[i]));
  return {
    reset: () => { slots.length = 0; effects.length = 0; cursor = 0; },
    render: () => { cursor = 0; },
    commit: () => { effects.splice(0).forEach((effect) => effect()); },
    unmount: () => { slots.forEach((slot) => slot.cleanup?.()); },
    useState: (initial: unknown) => {
      const slot = next();
      if (!("value" in slot)) slot.value = typeof initial === "function" ? initial() : initial;
      return [slot.value, (update: unknown) => {
        slot.value = typeof update === "function" ? update(slot.value) : update;
      }];
    },
    useRef: (initial: unknown) => {
      const slot = next();
      return slot.value ?? (slot.value = { current: initial });
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const slot = next();
      if (changed(slot, deps)) { slot.value = callback; slot.deps = deps; }
      return slot.value;
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const slot = next();
      if (!changed(slot, deps)) return;
      slot.deps = deps;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    },
  };
});
vi.mock("react", () => hooks);
import { useSandbox as runSandboxHook } from "./use-sandbox";

const file = (content: string): Doc<"files"> => ({
  _id: "app" as Id<"files">, _creationTime: 1, projectId: "project" as Id<"projects">,
  name: "App.tsx", type: "file", content, updatedAt: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const patch = vi.fn<typeof fetch>();
let files: Doc<"files">[];
let enabled: boolean;
const render = () => {
  hooks.render();
  const result = runSandboxHook({ files, enabled });
  hooks.commit();
  return result;
};
const edit = (content: string) => { files = [file(content)]; return render(); };
const payloads = () => patch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).files);

beforeEach(async () => {
  vi.useFakeTimers();
  hooks.reset();
  patch.mockReset();
  patch.mockImplementation(async () => Response.json({ success: true }));
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "PATCH") return patch(url, init);
    if (init?.method === "DELETE") return Response.json({ success: true });
    return new Response('{"type":"ready","sandboxId":"sbx_1","previewUrl":"https://preview.test"}\n');
  }));
  enabled = true;
  files = [file("boot")];
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(render().status).toBe("running");
  await vi.advanceTimersByTimeAsync(300);
});
afterEach(() => {
  hooks.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sandbox file sync acknowledgements", () => {
  it.each(["network", "http"])("retries a failed %s sync without another file edit", async (failure) => {
    if (failure === "network") patch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else patch.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    edit("changed");
    await vi.advanceTimersByTimeAsync(300);
    expect(patch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(payloads()).toEqual([[{ path: "App.tsx", content: "changed" }], [{ path: "App.tsx", content: "changed" }]]);
    edit("changed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("serializes inflight edits, sends the newest state and only acknowledges the sent snapshot", async () => {
    const inflight = deferred<Response>();
    patch.mockReturnValueOnce(inflight.promise);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    edit("intermediate");
    await vi.advanceTimersByTimeAsync(300);
    edit("latest");
    await vi.advanceTimersByTimeAsync(300);
    expect(patch).toHaveBeenCalledTimes(1);
    inflight.resolve(Response.json({ success: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(payloads()).toEqual([[{ path: "App.tsx", content: "first" }], [{ path: "App.tsx", content: "latest" }]]);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    expect(payloads().at(-1)).toEqual([{ path: "App.tsx", content: "first" }]);
  });

  it("retries with current files when they change during a failed request", async () => {
    const inflight = deferred<Response>();
    patch.mockReturnValueOnce(inflight.promise);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    edit("latest");
    await vi.advanceTimersByTimeAsync(300);
    inflight.resolve(Response.json({}, { status: 500 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(payloads()).toEqual([[{ path: "App.tsx", content: "first" }], [{ path: "App.tsx", content: "latest" }]]);
  });

  it("caps retries with backoff and exposes a restartable infrastructure error", async () => {
    patch.mockRejectedValue(new TypeError("Failed to fetch"));
    edit("changed");
    await vi.advanceTimersByTimeAsync(300);
    for (const delay of [1_000, 2_000, 4_000]) {
      const before = patch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(patch).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(patch).toHaveBeenCalledTimes(before + 1);
    }
    const result = render();
    expect(result.status).toBe("error");
    expect(result.errorKind).toBe("transient");
    expect(result.error).toMatch(/sync.*restart/i);
    expect(result.appError).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(4);
  });

  it("cancels retries on unmount", async () => {
    patch.mockRejectedValue(new TypeError("Failed to fetch"));
    edit("changed");
    await vi.advanceTimersByTimeAsync(300);
    hooks.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("aborts inflight writes and drops queued writes on unmount", async () => {
    const inflight = deferred<Response>();
    patch.mockReturnValueOnce(inflight.promise);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    const signal = patch.mock.calls[0][1]?.signal;
    edit("latest");
    await vi.advanceTimersByTimeAsync(300);
    hooks.unmount();
    expect(signal?.aborted).toBe(true);
    inflight.resolve(Response.json({ success: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("does not let an old response acknowledge files in a restarted sandbox", async () => {
    const inflight = deferred<Response>();
    patch.mockReturnValueOnce(inflight.promise);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    render().restart();
    edit("fresh boot");
    await vi.advanceTimersByTimeAsync(0);
    expect(render().status).toBe("running");
    inflight.resolve(Response.json({ success: true }));
    await vi.advanceTimersByTimeAsync(300);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(payloads().at(-1)).toEqual([{ path: "App.tsx", content: "first" }]);
  });

  it.each(["ERESOLVE", "ETIMEDOUT"])("hands install failure %s to the existing error path without retrying the file write", async (code) => {
    patch.mockResolvedValueOnce(Response.json({ success: true, installFailed: { exitCode: 1, code } }));
    edit("changed");
    await vi.advanceTimersByTimeAsync(300);
    const result = render();
    expect(result.terminalOutput).toContain(code);
    if (code === "ETIMEDOUT") expect(result.appError).toBeNull();
    else expect(result.appError).toMatchObject({ kind: "build", file: "package.json" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("reports an install failure even when files change during the reinstall", async () => {
    const inflight = deferred<Response>();
    patch.mockReturnValueOnce(inflight.promise);
    edit("first");
    await vi.advanceTimersByTimeAsync(300);
    edit("latest");
    await vi.advanceTimersByTimeAsync(300);
    inflight.resolve(Response.json({ success: true, installFailed: { exitCode: 1, code: "ERESOLVE" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(render().terminalOutput).toContain("ERESOLVE");
  });

  it.each(["disable", "restart"])("cancels pending retries on %s", async (action) => {
    patch.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = edit("changed");
    await vi.advanceTimersByTimeAsync(300);
    if (action === "restart") result.restart();
    else { enabled = false; render(); }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

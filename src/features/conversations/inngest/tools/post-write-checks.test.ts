import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistryCheck } from "./post-write-checks";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("registry checks", () => {
  it("deduplicates and caches registry 404s across tools in a run", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const check = createRegistryCheck();
    expect((await check(["missing", "missing"]))[0].message).toContain("does not exist");
    await check(["missing"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await createRegistryCheck()(["missing"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("warns about new or low-download packages and encodes scoped names", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ time: { created: new Date().toISOString() } }))
      .mockResolvedValueOnce(Response.json({ downloads: 800 }));
    vi.stubGlobal("fetch", fetch);
    expect((await createRegistryCheck()(["@scope/pkg"]))[0].message).toContain("created within 30 days");
    expect(fetch.mock.calls[0][0]).toBe("https://registry.npmjs.org/%40scope%2Fpkg");
  });
  it("does not warn on established packages", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ time: { created: "2020-01-01" } }))
      .mockResolvedValueOnce(Response.json({ downloads: 100_000 })));
    expect(await createRegistryCheck()(["known"])).toEqual([]);
  });
  it("skips network errors, invalid names and oversized responses softly", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("x".repeat(512_001)));
    vi.stubGlobal("fetch", fetch);
    const check = createRegistryCheck();
    expect((await check(["offline", "https://bad", "big"])).every((f) => f.message.includes("not checked"))).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("aborts within two seconds and caps concurrency across simultaneous calls", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    vi.stubGlobal("fetch", fetch);
    const check = createRegistryCheck();
    const pending = check(["a", "b", "c", "d", "e"]);
    expect((await check(["f"]))[0].message).toContain("busy");
    await vi.advanceTimersByTimeAsync(2000);
    const findings = await pending;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(findings).toHaveLength(5);
    expect(findings[0].message).toContain("registry unreachable");
  });
});

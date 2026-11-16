import { describe, expect, it } from "vitest";

import { WEBCONTAINER_VITE_PINS } from "../src/features/webcontainer-preview/utils/vite-pin";
import { checkStarterManifest, npmErrorCode, starterPins } from "./check-starter-manifest";

describe("checkStarterManifest", () => {
  it("covers every starter and the WebContainer fallback with exact pins", () => {
    const pins = starterPins();
    const users = new Set(pins.flatMap((pin) => pin.users));
    expect([...users].sort()).toEqual(["next", "start", "vite", "webcontainer"]);
    expect(pins).toContainEqual({ name: "next", version: expect.any(String), users: ["next"] });
    expect(pins).toContainEqual({ name: "vite", version: WEBCONTAINER_VITE_PINS.vite, users: ["webcontainer"] });

    // Registry mock: exactly the pinned versions exist. The WebContainer's older
    // vite/plugin-react pins see the starters' newer ones as info, not failures.
    const result = checkStarterManifest((name) => pins.filter((pin) => pin.name === name).map((pin) => pin.version));
    expect(result.failures).toEqual([]);
    expect(result.info.every((line) => line.includes("(webcontainer)"))).toBe(true);
    expect(result.summary).toContain(`${pins.length} exact pins; 0 failures`);
  });

  it("fails non-exact, unpublished and unreachable pins, and reports newer stable as info", () => {
    const pins = [
      { name: "range", version: "^1.0.0", users: ["vite"] },
      { name: "tag", version: "latest", users: ["vite"] },
      { name: "gone", version: "4.3.5", users: ["next"] },
      { name: "down", version: "1.0.0", users: ["start"] },
      { name: "old", version: "1.0.0", users: ["vite"] },
      { name: "single", version: "2.0.0", users: ["vite"] },
    ];
    const registry: Record<string, string | string[]> = {
      gone: ["4.3.4"],
      old: ["1.0.0", "1.1.0", "2.0.0", "3.0.0-beta.1"],
      single: "2.0.0",
    };
    const seen: string[] = [];
    const result = checkStarterManifest((name) => {
      seen.push(name);
      if (!(name in registry)) throw Object.assign(new Error("npm view failed"), { code: "ETIMEDOUT" });
      return registry[name];
    }, pins, [0, 0]);

    // The unreachable package is retried twice; the rest are viewed once.
    expect(seen).toEqual(["gone", "down", "down", "down", "old", "single"]);
    expect(result.failures).toEqual([
      "range@^1.0.0 (vite): not an exact version",
      "tag@latest (vite): not an exact version",
      "gone@4.3.5 (next): not published on the registry",
      "down@1.0.0 (start): npm view failed (ETIMEDOUT)",
    ]);
    expect(result.info).toEqual(["info: old@1.0.0 (vite): newer stable 2.0.0"]);
  });

  it("retries a registry blip, and fails a 404 at once with npm's code", () => {
    const e404 = Object.assign(new Error("Command failed"), { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "npm error code E404\n" });
    const reset = Object.assign(new Error("Command failed"), { status: 1, stdout: "", stderr: "npm error code ECONNRESET\n" });
    const pins = [
      { name: "flaky", version: "1.0.0", users: ["vite"] },
      { name: "missing", version: "1.0.0", users: ["next"] },
    ];
    const calls: string[] = [];
    const result = checkStarterManifest((name) => {
      calls.push(name);
      if (name === "missing") throw e404;
      if (calls.length === 1) throw reset;
      return ["1.0.0"];
    }, pins, [0, 0]);

    expect(calls).toEqual(["flaky", "flaky", "missing"]);
    expect(result.failures).toEqual(["missing@1.0.0 (next): npm view failed (E404)"]);
  });

  it("treats auth errors as final and stops at the time budget", () => {
    const e403 = Object.assign(new Error("Command failed"), { stderr: "npm error code E403\n" });
    const pins = [{ name: "private", version: "1.0.0", users: ["vite"] }];
    let calls = 0;
    const denied = checkStarterManifest(() => { calls++; throw e403; }, pins, [0, 0]);
    expect(calls).toBe(1);
    expect(denied.failures).toEqual(["private@1.0.0 (vite): npm view failed (E403)"]);

    const spent = checkStarterManifest(() => { throw new Error("unreachable"); }, pins, [0, 0], 0);
    expect(spent.failures).toEqual(["private@1.0.0 (vite): npm view failed (time budget spent)"]);
  });

  it("reads npm's error code from --json stdout, then stderr, then the spawn error", () => {
    expect(npmErrorCode({ stdout: '{"error":{"code":"E404"}}' })).toBe("E404");
    expect(npmErrorCode({ stdout: "", stderr: "npm error code ECONNRESET\nnpm error network" })).toBe("ECONNRESET");
    expect(npmErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
    expect(npmErrorCode(new Error("boom"))).toBe("unknown error");
  });
});

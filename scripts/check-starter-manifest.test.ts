import { describe, expect, it } from "vitest";

import { checkStarterManifest, starterPins } from "./check-starter-manifest";

describe("checkStarterManifest", () => {
  it("covers every starter and the WebContainer fallback with exact pins", () => {
    const pins = starterPins();
    const users = new Set(pins.flatMap((pin) => pin.users));
    expect([...users].sort()).toEqual(["next", "start", "vite", "webcontainer"]);
    expect(pins).toContainEqual({ name: "next", version: expect.any(String), users: ["next"] });
    expect(pins.filter((pin) => pin.name === "vite").map((pin) => pin.users)).toEqual([["vite", "start"], ["webcontainer"]]);

    // Registry mock: exactly the pinned versions exist.
    const result = checkStarterManifest((name) => pins.filter((pin) => pin.name === name).map((pin) => pin.version));
    expect(result.failures).toEqual([]);
    expect(result.info).toEqual([]);
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
      if (!(name in registry)) throw new Error("E404");
      return registry[name];
    }, pins);

    expect(seen).toEqual(["gone", "down", "old", "single"]);
    expect(result.failures).toEqual([
      "range@^1.0.0 (vite): not an exact version",
      "tag@latest (vite): not an exact version",
      "gone@4.3.5 (next): not published on the registry",
      "down@1.0.0 (start): npm view failed",
    ]);
    expect(result.info).toEqual(["info: old@1.0.0 (vite): newer stable 2.0.0"]);
  });
});

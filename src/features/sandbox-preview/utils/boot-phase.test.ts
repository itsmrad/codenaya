import { describe, expect, it } from "vitest";

import { isBootPhase, recordBootPhase, type BootHistory } from "./boot-phase";

describe("boot phase protocol", () => {
  it("retains timestamps and log boundaries across batched phases", () => {
    let history: BootHistory = {};
    history = recordBootPhase(history, "create", 1000, 0);
    history = recordBootPhase(history, "files", 3500, 42);
    history = recordBootPhase(history, "install", 6000, 98);
    expect(history.files!.at - history.create!.at).toBe(2500);
    expect(history.install!.logAt - history.files!.logAt).toBe(56);
    expect(recordBootPhase(history, "files", 9000, 120)).toBe(history);
  });

  it("ignores unknown phases and invalid timestamps", () => {
    const history: BootHistory = {};
    expect(isBootPhase("ready")).toBe(true);
    expect(isBootPhase("unknown")).toBe(false);
    for (const at of [undefined, "1000", NaN, Infinity, -1]) {
      expect(recordBootPhase(history, "create", at, 0)).toBe(history);
    }
    expect(recordBootPhase(history, "unknown", 1000, 0)).toBe(history);
  });
});

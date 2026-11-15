import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("e2b", () => ({ Sandbox: {} }));

import { getDefaultProvider, getProvider } from "./registry";
import { SandboxConfigError } from "./types";

describe("sandbox provider registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the E2B adapter when its key is set", () => {
    vi.stubEnv("E2B_API_KEY", " key_1 ");

    expect(getProvider("e2b").id).toBe("e2b");
    expect(getDefaultProvider().id).toBe("e2b");
  });

  it("treats a provider without a key as not configured", () => {
    vi.stubEnv("E2B_API_KEY", " ");

    expect(() => getDefaultProvider()).toThrow(SandboxConfigError);
    expect(() => getDefaultProvider()).toThrow("E2B_API_KEY is not set");
  });
});

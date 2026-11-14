// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => vi.unstubAllEnvs());

describe("swarm.isEnabled (kill switch)", () => {
  test("is on when SWARM_ENABLED is unset or anything but an off value", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.swarm.isEnabled, {})).toBe(true);
    for (const value of ["true", "1", "yes", ""]) {
      vi.stubEnv("SWARM_ENABLED", value);
      expect(await t.query(api.swarm.isEnabled, {})).toBe(true);
    }
  });

  test.each(["false", "0", "off", " FALSE "])("is off for %j, without sign-in", async (value) => {
    vi.stubEnv("SWARM_ENABLED", value);
    expect(await convexTest(schema, modules).query(api.swarm.isEnabled, {})).toBe(false);
  });
});

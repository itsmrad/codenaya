// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_KEY = "test-internal-key";

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("proWaitlist").collect());

describe("waitlist.join (#250)", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("stores an email once, whatever its case", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.waitlist.join, { internalKey: INTERNAL_KEY, email: "Ada@Example.com" });
    await t.mutation(api.waitlist.join, { internalKey: INTERNAL_KEY, email: " ada@example.com " });

    expect(await rows(t)).toEqual([expect.objectContaining({ email: "ada@example.com" })]);
  });

  test("learns the account of a signed-out sign-up later, and keeps the first one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.waitlist.join, { internalKey: INTERNAL_KEY, email: "ada@example.com" });
    await t.mutation(api.waitlist.join, { internalKey: INTERNAL_KEY, email: "ada@example.com", userId: "user_1" });
    await t.mutation(api.waitlist.join, { internalKey: INTERNAL_KEY, email: "ada@example.com", userId: "user_2" });

    expect(await rows(t)).toEqual([expect.objectContaining({ userId: "user_1" })]);
  });

  test("refuses a call without the internal key", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.waitlist.join, { internalKey: "wrong", email: "ada@example.com" }),
    ).rejects.toThrow();
    expect(await rows(t)).toEqual([]);
  });
});

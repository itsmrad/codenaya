// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";

describe("projects built counter", () => {
  test("is null before anything is counted", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.stats.projectsBuilt, {})).toBeNull();
  });

  test("counts every created project and does not drop on delete", async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity({ subject: ALICE });

    const first = await alice.mutation(api.projects.create, { name: "One" });
    await alice.mutation(api.projects.create, { name: "Two" });
    await alice.mutation(api.projects.duplicate, { id: first });
    expect(await t.query(api.stats.projectsBuilt, {})).toBe(3);

    await t.run(async (ctx) => {
      await ctx.db.delete("projects", first);
    });
    expect(await t.query(api.stats.projectsBuilt, {})).toBe(3);
  });

  test("backfill recounts existing projects across batches", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        for (let i = 0; i < 501; i++) {
          await ctx.db.insert("projects", { name: `p${i}`, ownerId: ALICE, updatedAt: 0 });
        }
        // A stale value the backfill must overwrite, not add to.
        await ctx.db.insert("counters", { name: "projectsBuilt", value: 7 });
      });

      await t.mutation(internal.stats.backfillProjectsBuilt, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await t.query(api.stats.projectsBuilt, {})).toBe(501);
    } finally {
      vi.useRealTimers();
    }
  });
});

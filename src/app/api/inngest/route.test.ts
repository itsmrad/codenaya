/**
 * Inngest refuses to sync the whole app when any function's concurrency limit
 * exceeds the plan's, which leaves production pointed at a dead deployment.
 */

import { describe, expect, it, vi } from "vitest";

const served = vi.hoisted(() => ({ functions: [] as unknown[] }));

vi.mock("inngest/next", () => ({
  serve: (options: { functions: unknown[] }) => {
    served.functions = options.functions;
    return {};
  },
}));

import { INNGEST_PLAN_CONCURRENCY_LIMIT } from "@/inngest/client";
import "./route";

type Concurrency = number | { limit: number } | Array<number | { limit: number }>;

describe("served Inngest functions", () => {
  it("stay within the plan's concurrency limit", () => {
    expect(served.functions.length).toBeGreaterThan(0);
    for (const fn of served.functions as Array<{ id: () => string; opts: { concurrency?: Concurrency } }>) {
      const entries = [fn.opts.concurrency ?? []].flat();
      for (const entry of entries) {
        const limit = typeof entry === "number" ? entry : entry.limit;
        expect(limit, fn.id()).toBeLessThanOrEqual(INNGEST_PLAN_CONCURRENCY_LIMIT);
      }
    }
  });
});

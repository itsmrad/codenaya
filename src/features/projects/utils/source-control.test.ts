import { describe, expect, test } from "vitest";
import type { Checkpoint } from "@/features/conversations/hooks/use-checkpoints";
import type { Id } from "../../../../convex/_generated/dataModel";
import { comparisonBaseline } from "./source-control";

const checkpoint = (id: string, run = false): Checkpoint => ({
  _id: id as Id<"checkpoints">, _creationTime: 1, label: id, fileCount: 1,
  messageId: run ? "run" as Id<"messages"> : undefined,
});
describe("comparison baseline", () => {
  test("prefers newest run even with a newer delete snapshot", () => {
    const rows = [checkpoint("delete"), checkpoint("latest-run", true), checkpoint("older-run", true)];
    expect(comparisonBaseline(rows)?.label).toBe("latest-run");
    expect(comparisonBaseline(rows, "delete")?.label).toBe("delete");
    expect(comparisonBaseline(rows, "pruned")?.label).toBe("latest-run");
  });
  test("falls back to newest snapshot or an empty state", () => {
    expect(comparisonBaseline([checkpoint("new"), checkpoint("old")])?.label).toBe("new");
    expect(comparisonBaseline([])).toBeUndefined();
  });
});

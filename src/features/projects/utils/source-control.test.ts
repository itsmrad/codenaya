import { describe, expect, test } from "vitest";
import type { Checkpoint } from "@/features/conversations/hooks/use-checkpoints";
import type { Id } from "../../../../convex/_generated/dataModel";
import { checkpointMenuLabel, comparisonBaseline } from "./source-control";

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

describe("checkpoint menu label", () => {
  const now = new Date(2026, 10, 16, 12);
  const run = (date: Date, label?: string) => ({
    ...checkpoint("run", true), _creationTime: date.getTime(), label,
  });

  test("uses a short time today, yesterday, and a short date for older checkpoints", () => {
    expect(checkpointMenuLabel(run(new Date(2026, 10, 16, 4, 32)), now).time).toBe("4:32 AM");
    expect(checkpointMenuLabel(run(new Date(2026, 10, 15, 21, 2)), now).time).toBe("Yesterday 9:02 PM");
    expect(checkpointMenuLabel(run(new Date(2026, 10, 14, 21, 2)), now).time).toBe("Nov 14, 9:02 PM");
  });

  test("uses calendar days across midnight and year boundaries", () => {
    expect(checkpointMenuLabel(run(new Date(2025, 11, 31, 23, 59)), new Date(2026, 0, 1, 0, 1)).time)
      .toBe("Yesterday 11:59 PM");
  });

  test("keeps the entire prompt and full timestamp for titles, leaving truncation to CSS", () => {
    const prompt = "Build a recipe box with routes and a form. ".repeat(30);
    const date = new Date(2026, 10, 16, 4, 32, 34);
    const result = checkpointMenuLabel(run(date, prompt), now);
    expect(result.label).toBe(`Before run · ${prompt}`);
    expect(result.title).toBe(`Before run · ${prompt} · ${date.toLocaleString()}`);
  });

  test("omits the prompt separator when missing and preserves snapshot labels", () => {
    expect(checkpointMenuLabel(run(now), now).label).toBe("Before run");
    expect(checkpointMenuLabel(run(now, ""), now).label).toBe("Before run");
    expect(checkpointMenuLabel(checkpoint("Pull snapshot"), now).label).toBe("Snapshot · Pull snapshot");
  });
});

import { describe, expect, test } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import { AGENT_FAILURE_MESSAGE, LOST_RUN_MESSAGE } from "./agent-steps";
import { followUpAction } from "./follow-up";

const runId = "run" as Id<"messages">;
const followUp = { projectId: "p1", text: "Now add a footer", afterMessageId: runId };
type Messages = NonNullable<Parameters<typeof followUpAction>[1]>;
const run = (fields: Partial<Messages[number]>): Messages => [
  { _id: "other" as Id<"messages">, status: "completed" as const, content: "Earlier reply" },
  { _id: runId, content: "", ...fields },
];

describe("followUpAction", () => {
  test("waits while its run is going or not in view", () => {
    expect(followUpAction(followUp, run({ status: "processing" }))).toBe("wait");
    expect(followUpAction(followUp, undefined)).toBe("wait");
    expect(followUpAction(followUp, run({ status: "processing" }).slice(0, 1))).toBe("wait");
  });

  test("sends once the run completed", () => {
    expect(followUpAction(followUp, run({ status: "completed", content: "Added the hero." }))).toBe("send");
  });

  test("drops it when the run was stopped or failed", () => {
    expect(followUpAction(followUp, run({ status: "cancelled" }))).toBe("drop");
    expect(followUpAction(followUp, run({ status: "completed", content: AGENT_FAILURE_MESSAGE }))).toBe("drop");
    expect(followUpAction(followUp, run({ status: "completed", content: LOST_RUN_MESSAGE }))).toBe("drop");
    expect(followUpAction(followUp, run({ status: "completed", stuck: { reason: "repeated-error" } }))).toBe("drop");
  });
});

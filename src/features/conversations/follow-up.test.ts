import { describe, expect, test } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import { LOST_RUN_MESSAGE } from "./agent-steps";
import { AGENT_FAILURE_MESSAGE, DISPATCH_FAILED_MESSAGE, KEY_FAILURE_SUFFIX } from "./failed-run-reply";
import { composerSubmitAction, followUpAction } from "./follow-up";
import { useChatStore } from "./store/use-chat-store";

const runId = "run" as Id<"messages">;
const followUp = { text: "Now add a footer", afterMessageId: runId };
type Messages = NonNullable<Parameters<typeof followUpAction>[1]>;
const run = (fields: Partial<Messages[number]>): Messages => [
  { _id: "other" as Id<"messages">, status: "completed" as const, content: "Earlier reply" },
  { _id: runId, content: "", ...fields },
];

describe("followUpAction", () => {
  test("waits while its run is going or not loaded", () => {
    expect(followUpAction(followUp, run({ status: "processing" }))).toBe("wait");
    expect(followUpAction(followUp, undefined)).toBe("wait");
    expect(followUpAction(followUp, run({ status: "processing" }).slice(0, 1))).toBe("wait");
  });

  test("sends once the run completed and the chat is free", () => {
    const done = run({ status: "completed", content: "Added the hero." });
    expect(followUpAction(followUp, done)).toBe("send");
    // A send in flight, another run or an outside message: it waits its turn.
    expect(followUpAction(followUp, done, true)).toBe("wait");
    // A stopped run is dropped even while the chat is busy.
    expect(followUpAction(followUp, run({ status: "cancelled" }), true)).toBe("drop");
  });

  test("drops it when the run was stopped or failed", () => {
    expect(followUpAction(followUp, run({ status: "cancelled" }))).toBe("drop");
    for (const content of [AGENT_FAILURE_MESSAGE, LOST_RUN_MESSAGE, DISPATCH_FAILED_MESSAGE, `Bad key. ${KEY_FAILURE_SUFFIX}`]) {
      expect(followUpAction(followUp, run({ status: "completed", content }))).toBe("drop");
    }
    expect(followUpAction(followUp, run({ status: "completed", stuck: { reason: "repeated-error" } }))).toBe("drop");
  });
});

describe("composerSubmitAction", () => {
  const during = { running: true, text: "", hasImages: false, hasFollowUp: false };

  test("never stops a run: an empty submit during a run does nothing", () => {
    expect(composerSubmitAction(during)).toBe("ignore");
    expect(composerSubmitAction({ ...during, text: "  ", hasFollowUp: true })).toBe("ignore");
  });

  test("queues one follow-up during a run, without images", () => {
    expect(composerSubmitAction({ ...during, text: "Add a footer" })).toBe("queue");
    expect(composerSubmitAction({ ...during, text: "Add a footer", hasFollowUp: true })).toBe("already-queued");
    expect(composerSubmitAction({ ...during, text: "Add a footer", hasImages: true })).toBe("images-not-queued");
  });

  test("sends when no run is going", () => {
    expect(composerSubmitAction({ ...during, running: false })).toBe("send");
  });
});

describe("follow-ups in the chat store", () => {
  test("are kept per conversation and taken once", () => {
    const { setFollowUp, takeFollowUp } = useChatStore.getState();
    setFollowUp("a", { text: "for A", afterMessageId: runId, mode: "plan" });
    setFollowUp("b", { text: "for B", afterMessageId: runId });

    expect(useChatStore.getState().followUps.a.text).toBe("for A");
    // Sent with the mode it was queued in.
    expect(takeFollowUp("a")).toMatchObject({ text: "for A", mode: "plan" });
    expect(takeFollowUp("a")).toBeNull();
    expect(useChatStore.getState().followUps.b.text).toBe("for B");
  });
});

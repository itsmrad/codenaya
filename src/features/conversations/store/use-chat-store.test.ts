import { beforeEach, describe, expect, it, vi } from "vitest";

import { type SendResult, sendQueuedMessage, useChatStore } from "./use-chat-store";

/** A send that settles when the test says so, like a slow /api/messages POST. */
const deferredSend = () => {
  let settle!: (result: SendResult) => void;
  const send = vi.fn<(text: string) => Promise<SendResult>>(
    () => new Promise((resolve) => (settle = resolve)),
  );
  return { send, settle: (result: SendResult) => settle(result) };
};

describe("queued chat messages", () => {
  beforeEach(() => useChatStore.setState({ queuedMessage: null }));

  it("is taken only by the chat of the project it was queued for, once", () => {
    const { queueMessage, takeQueuedMessage } = useChatStore.getState();
    queueMessage({ projectId: "project_a", text: "Fix the secrets" });

    // The user switched to another project: its chat must not send it.
    expect(takeQueuedMessage("project_b")).toBeNull();
    expect(useChatStore.getState().queuedMessage).not.toBeNull();

    expect(takeQueuedMessage("project_a")).toBe("Fix the secrets");
    expect(takeQueuedMessage("project_a")).toBeNull();
  });

  it("sends a double-clicked fix once and counts it once (#223)", async () => {
    const onSent = vi.fn();
    const { send, settle } = deferredSend();
    const { queueMessage } = useChatStore.getState();

    queueMessage({ projectId: "project_a", text: "fix it", onSent });
    const first = sendQueuedMessage("project_a", send);
    // The second click lands while the first POST is still in flight.
    queueMessage({ projectId: "project_a", text: "fix it", onSent });
    void sendQueuedMessage("project_a", send);
    expect(useChatStore.getState().queuedMessage).toMatchObject({ text: "fix it", sending: true });

    settle("sent");
    await first;

    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedMessage).toBeNull();
  });

  it("leaves another project's message for its own chat", async () => {
    const send = vi.fn(async () => "sent" as const);
    useChatStore.getState().queueMessage({ projectId: "project_a", text: "fix it" });

    await sendQueuedMessage("project_b", send);

    expect(send).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessage).toMatchObject({ projectId: "project_a" });
  });

  it.each(["blocked", "failed"] as const)("doesn't count a %s send as an attempt", async (result) => {
    const onSent = vi.fn();
    useChatStore.getState().queueMessage({ projectId: "project_a", text: "fix it", onSent });

    await sendQueuedMessage("project_a", async () => result);

    expect(onSent).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessage).toBeNull();
  });

  it("frees the queue when the send throws", async () => {
    useChatStore.getState().queueMessage({ projectId: "project_a", text: "fix it" });

    await expect(
      sendQueuedMessage("project_a", async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");

    expect(useChatStore.getState().queuedMessage).toBeNull();
  });
});

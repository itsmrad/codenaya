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

describe("queued chat messages (#223)", () => {
  beforeEach(() => useChatStore.setState({ queuedMessage: null }));

  it("sends a double-clicked fix once and counts it once", async () => {
    const onSent = vi.fn();
    const { send, settle } = deferredSend();
    const { queueMessage } = useChatStore.getState();

    queueMessage({ text: "fix it", onSent });
    const first = sendQueuedMessage(send);
    // The second click lands while the first POST is still in flight.
    queueMessage({ text: "fix it", onSent });
    void sendQueuedMessage(send);
    expect(useChatStore.getState().queuedMessage).toMatchObject({ text: "fix it", sending: true });

    settle("sent");
    await first;

    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queuedMessage).toBeNull();
  });

  it.each(["blocked", "failed"] as const)("doesn't count a %s send as an attempt", async (result) => {
    const onSent = vi.fn();
    useChatStore.getState().queueMessage({ text: "fix it", onSent });

    await sendQueuedMessage(async () => result);

    expect(onSent).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessage).toBeNull();
  });

  it("frees the queue when the send throws", async () => {
    useChatStore.getState().queueMessage({ text: "fix it" });

    await expect(
      sendQueuedMessage(async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");

    expect(useChatStore.getState().queuedMessage).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { useChatStore } from "./use-chat-store";

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
});

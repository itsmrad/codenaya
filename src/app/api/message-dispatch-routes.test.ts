import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  inngestSend: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));
// Instantiates the Workflow SDK at import time; only the Inngest path is used.
vi.mock("@/features/conversations/workflow/client", () => ({
  startProcessMessageWorkflow: vi.fn(),
  cancelProcessMessageWorkflowByMessageId: vi.fn(),
}));

import { POST as messagesPOST } from "./messages/route";
import { POST as cancelPOST } from "./messages/cancel/route";
import { POST as createWithPromptPOST } from "./projects/create-with-prompt/route";
import {
  DISPATCH_FAILED_ERROR,
  DISPATCH_FAILED_MESSAGE,
} from "@/lib/message-processor";

const post = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify(body),
  });

const routes = [
  {
    name: "messages",
    call: () => messagesPOST(post({ conversationId: "c1", message: "Build a todo app" })),
    successBody: { success: true, eventId: "evt_1", messageId: "m_assistant" },
    failureBody: { messageId: "m_assistant" },
  },
  {
    name: "projects/create-with-prompt",
    call: () => createWithPromptPOST(post({ prompt: "Build a todo app" })),
    successBody: { projectId: "p1" },
    failureBody: { projectId: "p1" },
  },
];

describe.each(routes)("POST /api/$name", ({ call, successBody, failureBody }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("MESSAGE_PROCESSOR", "inngest");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    // getConversationById, then getProcessingMessages (messages route only).
    mocks.query
      .mockResolvedValueOnce({ _id: "c1", projectId: "p1" })
      .mockResolvedValueOnce([]);
    mocks.mutation.mockImplementation(async (_ref, args) => {
      if ("projectName" in args) return { projectId: "p1", conversationId: "c1" };
      if (args.role === "user") return "m_user";
      if (args.role === "assistant") return "m_assistant";
      return null;
    });
    mocks.inngestSend.mockResolvedValue({ ids: ["evt_1"] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("dispatches the assistant placeholder", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(successBody);
    expect(mocks.mutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: DISPATCH_FAILED_MESSAGE }),
    );
  });

  it("marks the placeholder failed and returns 502 when dispatch throws", async () => {
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));

    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: DISPATCH_FAILED_ERROR,
      code: "dispatch_failed",
      ...failureBody,
    });
    // `updateMessageContent` resolves the placeholder as completed with this text.
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      messageId: "m_assistant",
      content: DISPATCH_FAILED_MESSAGE,
    });
  });

  it("still returns 502 when marking the placeholder failed also fails", async () => {
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));
    const createMutation = mocks.mutation.getMockImplementation()!;
    mocks.mutation.mockImplementation(async (ref, args) => {
      if (args.content === DISPATCH_FAILED_MESSAGE) throw new Error("Convex unavailable");
      return createMutation(ref, args);
    });

    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "dispatch_failed" });
  });
});

describe("cancelling processing messages while the backend is down", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    vi.stubEnv("MESSAGE_PROCESSOR", "inngest");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.inngestSend.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8288"));
    mocks.mutation.mockImplementation(async (_ref, args) =>
      args.role === "assistant" ? "m_assistant" : null,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cancelledStuckMessage = () =>
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "test-key",
      messageId: "m_stuck",
      status: "cancelled",
    });

  it("Stop still marks the stuck message cancelled", async () => {
    mocks.query.mockResolvedValueOnce([{ _id: "m_stuck" }]);

    const res = await cancelPOST(post({ projectId: "p1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled: true, messageIds: ["m_stuck"] });
    cancelledStuckMessage();
  });

  it("a new message clears the stuck one before reporting its own failure", async () => {
    mocks.query
      .mockResolvedValueOnce({ _id: "c1", projectId: "p1" })
      .mockResolvedValueOnce([{ _id: "m_stuck" }]);

    const res = await messagesPOST(post({ conversationId: "c1", message: "Hi" }));

    expect(res.status).toBe(502);
    cancelledStuckMessage();
  });
});

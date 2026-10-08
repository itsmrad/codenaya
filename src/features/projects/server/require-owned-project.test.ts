import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));

import { requireOwnedConversation, requireOwnedProject } from "./require-owned-project";

const args = { internalKey: "test-key", userId: "user_1" };

describe("requireOwnedProject", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("returns the project the user owns", async () => {
    const project = { _id: "p1", ownerId: "user_1" };
    mocks.query.mockResolvedValue(project);

    const result = await requireOwnedProject({ ...args, projectId: "p1" });

    expect(result).toEqual({ found: project, notFound: undefined });
    const [ref, queryArgs] = mocks.query.mock.calls[0];
    expect(getFunctionName(ref)).toBe("system:getOwnedProject");
    expect(queryArgs).toEqual({ ...args, projectId: "p1" });
  });

  it("returns a 404 JSON response for a project the user does not own", async () => {
    mocks.query.mockResolvedValue(null);

    const { found, notFound } = await requireOwnedProject({ ...args, projectId: "p2" });

    expect(found).toBeUndefined();
    expect(notFound?.status).toBe(404);
    expect(await notFound?.json()).toEqual({ error: "Project not found" });
  });
});

describe("requireOwnedConversation", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("returns the conversation when the user owns its project", async () => {
    const conversation = { _id: "c1", projectId: "p1" };
    mocks.query.mockResolvedValue(conversation);

    const result = await requireOwnedConversation({ ...args, conversationId: "c1" });

    expect(result).toEqual({ found: conversation, notFound: undefined });
    expect(getFunctionName(mocks.query.mock.calls[0][0])).toBe("system:getOwnedConversation");
  });

  it("returns a 404 JSON response otherwise", async () => {
    mocks.query.mockResolvedValue(null);

    const { notFound } = await requireOwnedConversation({ ...args, conversationId: "c2" });

    expect(notFound?.status).toBe(404);
    expect(await notFound?.json()).toEqual({ error: "Conversation not found" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), owned: vi.fn(), query: vi.fn(), mutation: vi.fn(), cancel: vi.fn() }));
vi.mock("@/features/auth/server/require-user-id", () => ({ requireUserId: mocks.user }));
vi.mock("@/features/projects/server/require-owned-project", () => ({ requireOwnedProject: mocks.owned }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/lib/message-processor", () => ({ cancelProcessingMessage: mocks.cancel }));

import { POST } from "./route";

const request = (body: object) => new Request("http://localhost/api/messages/cancel", {
  method: "POST", body: JSON.stringify(body),
});

describe("POST /api/messages/cancel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.user.mockResolvedValue({ userId: "owner" });
    mocks.owned.mockResolvedValue({ found: { _id: "project" } });
    mocks.query.mockResolvedValue([{ _id: "run" }]);
    mocks.mutation.mockResolvedValue("undo-checkpoint");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("waits for cancellation before restoring the authenticated owner's run", async () => {
    const order: string[] = [];
    mocks.cancel.mockImplementation(async () => { order.push("cancel"); });
    mocks.mutation.mockImplementation(async () => { order.push("restore"); return "undo-checkpoint"; });
    const response = await POST(request({ projectId: "project", messageId: "run", undo: true }));
    expect(order).toEqual(["cancel", "restore"]);
    expect(mocks.mutation.mock.calls[0][1]).toEqual({ internalKey: "internal", ownerId: "owner", messageId: "run" });
    expect(await response.json()).toMatchObject({ cancelled: true, undoCheckpointId: "undo-checkpoint" });
  });

  it("does not cancel a newer run when the undo target is stale", async () => {
    const response = await POST(request({ projectId: "project", messageId: "old-run", undo: true }));
    expect(response.status).toBe(409);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("keeps plain Stop without restoring", async () => {
    await POST(request({ projectId: "project" }));
    expect(mocks.cancel).toHaveBeenCalledWith({ internalKey: "internal", messageId: "run" });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("does nothing with no processing run", async () => {
    mocks.query.mockResolvedValue([]);
    const response = await POST(request({ projectId: "project", undo: true, messageId: "run" }));
    expect(await response.json()).toMatchObject({ cancelled: false });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

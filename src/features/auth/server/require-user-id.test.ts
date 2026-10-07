import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));

import { requireUserId } from "./require-user-id";

describe("requireUserId", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
  });

  it("returns the signed-in user's id", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_123" });

    const result = await requireUserId();

    expect(result).toEqual({ userId: "user_123", unauthorized: undefined });
  });

  it("returns a 401 JSON response for signed-out callers", async () => {
    mocks.auth.mockResolvedValue({ userId: null });

    const { userId, unauthorized } = await requireUserId();

    expect(userId).toBeUndefined();
    expect(unauthorized?.status).toBe(401);
    expect(await unauthorized?.json()).toEqual({ error: "Unauthorized" });
  });
});

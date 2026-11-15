import { getFunctionName } from "convex/server";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  mutation: vi.fn(),
  seed: vi.fn(),
  takePromoRun: vi.fn(),
  requireModelChoice: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { mutation: mocks.mutation } }));
vi.mock("@/features/templates/server/seed-template", () => ({ seedTemplateFiles: mocks.seed }));
vi.mock("@/features/ai-providers/server/resolve-run-model", () => ({
  modelChoiceSchema: z.any(),
  requireModelChoice: mocks.requireModelChoice,
  takePromoRun: mocks.takePromoRun,
}));
vi.mock("@/lib/message-processor", () => ({
  DISPATCH_FAILED_ERROR: "dispatch failed",
  dispatchProcessMessageOrFail: mocks.dispatch,
}));

import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "./route";

const post = (body: unknown) =>
  new Request("http://localhost/api/projects/create-with-prompt", {
    method: "POST",
    body: JSON.stringify({ prompt: "Build it", model: "auto", ...(body as object) }),
  });

const calledMutations = () => mocks.mutation.mock.calls.map(([ref]) => getFunctionName(ref));

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
  mocks.mutation.mockImplementation(async (ref) =>
    getFunctionName(ref) === "system:createProjectWithConversation"
      ? { projectId: "p1", conversationId: "c1" }
      : "m1",
  );
  mocks.takePromoRun.mockResolvedValue({ promoRun: { refund: vi.fn() } });
  mocks.dispatch.mockResolvedValue(true);
  mocks.seed.mockResolvedValue(true);
  mocks.requireModelChoice.mockResolvedValue({ runModel: { kind: "auto" } });
});

describe("POST /api/projects/create-with-prompt", () => {
  it("seeds an instant template with no message, run or promo run (#362)", async () => {
    const res = await POST(post({ templateId: "landing-page" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: "p1" });
    expect(calledMutations()).toEqual(["system:createProjectWithConversation"]);
    expect(mocks.mutation.mock.calls[0][1]).not.toHaveProperty("firstBuildPending");
    expect(mocks.seed).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", template: expect.objectContaining({ id: "landing-page" }) }),
    );
    expect(mocks.requireModelChoice).not.toHaveBeenCalled();
    expect(mocks.takePromoRun).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("answers 502 when an instant template's seed stops partway", async () => {
    mocks.seed.mockResolvedValue(false);

    const res = await POST(post({ templateId: "admin-crud" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "seed_failed" });
    expect(calledMutations()).not.toContain("system:createMessage");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("still runs the agent for a prompt-flow template", async () => {
    const res = await POST(post({ templateId: "blog" }));

    expect(res.status).toBe(200);
    expect(calledMutations().filter((name) => name === "system:createMessage")).toHaveLength(2);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
});

/**
 * Images and catalog changes (#322): the send checked the model reads images,
 * but the run re-reads the catalog. A model removed, hidden or switched to
 * text-only since then must never get the images.
 */

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("@/lib/convex-client", async () => {
  const { withEnvPlatform } = await import("@/features/ai-providers/server/active-platform.mock");
  return { convex: { query: withEnvPlatform(mocks.query, mocks.catalog), mutation: mocks.mutation } };
});

import { RUN_IMAGES_REFUSED_MESSAGE } from "@/features/ai-providers/server/resolve-run-model";

import { drive, text } from "./process-message.driver";

const IMAGE = "https://example.com/mockup.png";

const QUERIES: Record<string, () => unknown> = {
  "system:getConversationById": () => ({ title: "Existing chat" }),
  "system:getRecentMessages": () => [
    { _id: "u1", role: "user", content: "Match this", imageUrls: [IMAGE] },
    { _id: "m1", role: "assistant", content: "", status: "processing" },
  ],
  "system:getProjectById": () => ({ ownerId: "user_1" }),
  "system:getProjectMcpConnections": () => [],
  "system:getProjectFiles": () => [],
  "system:getProjectSkills": () => [],
};

const model = (id: string, vision: boolean, hidden = false) => ({
  id,
  name: id,
  vendor: "x",
  provider: "openrouter",
  providerModelId: id,
  vision,
  tools: "reported",
  pricing: { mode: "blended", usdPerMTok: 1 },
  access: "everyone",
  hidden,
});

const catalog = (...models: ReturnType<typeof model>[]) => ({
  models,
  defaultModelId: "text-default",
  utilityModelId: "text-default",
});

const replies = () =>
  mocks.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "system:updateMessageContent")
    .map(([, args]) => args.content);

// The send routed Auto's image send to "seer"; the run sees the catalog after a change.
const run = () => drive({ modelId: "seer" }, [{ data: text("Done.") }], "Match this");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-platform");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.query.mockImplementation(async (ref) => QUERIES[getFunctionName(ref)]?.());
  mocks.mutation.mockResolvedValue(null);
});

describe("processMessage with images after a catalog change", () => {
  it.each([
    ["removed", catalog(model("text-default", false))],
    ["hidden", catalog(model("text-default", false), model("seer", true, true))],
    ["switched to text-only", catalog(model("text-default", false), model("seer", false))],
  ])("refuses the run when the model was %s, sending nothing", async (_, saved) => {
    mocks.catalog.mockReturnValue(saved);

    const outcome = await run();

    expect(outcome.inferenceUrls).toEqual([]);
    expect(replies()).toEqual([RUN_IMAGES_REFUSED_MESSAGE]);
  });

  it("still sends the images to a model that reads them", async () => {
    mocks.catalog.mockReturnValue(catalog(model("text-default", false), model("seer", true)));

    const outcome = await run();

    expect(JSON.stringify(outcome.inferenceBodies)).toContain(IMAGE);
    expect(replies()).not.toContain(RUN_IMAGES_REFUSED_MESSAGE);
  });
});

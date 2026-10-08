import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  generateObject: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  openProviderKey: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/features/ai-providers/server/sealed-key", () => ({
  openProviderKey: mocks.openProviderKey,
}));

import { POST as suggestionPOST } from "./suggestion/route";
import { POST as quickEditPOST } from "./quick-edit/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/editor", {
    method: "POST",
    body: JSON.stringify(body),
  });

const openAiKey = {
  _id: "key_1",
  userId: "user_1",
  provider: "openai" as const,
  label: "Work key",
  status: "active" as const,
};

const routes = [
  {
    name: "suggestion",
    call: () =>
      suggestionPOST(
        post({
          fileName: "index.ts",
          code: "const a = ",
          currentLine: "const a = ",
          textBeforeCursor: "const a = ",
          textAfterCursor: "",
          lineNumber: 1,
        }),
      ),
    result: { suggestion: "1;" },
  },
  {
    name: "quick-edit",
    call: () =>
      quickEditPOST(post({ selectedCode: "let a = 1", instruction: "use const" })),
    result: { editedCode: "const a = 1" },
  },
];

describe.each(routes)("POST /api/$name", ({ call, result }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_SUGGESTION_MODEL", "");
    vi.stubEnv("OPENROUTER_QUICK_EDIT_MODEL", "");
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "ik");
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.generateObject.mockResolvedValue({ object: result });
    // No default key: the platform model.
    mocks.query.mockResolvedValue(null);
    mocks.openProviderKey.mockResolvedValue("sk-user-secret");
  });

  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });

    const res = await call();

    expect(res.status).toBe(401);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("returns a 503 JSON error when OpenRouter is not configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const res = await call();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "AI is not configured" });
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("generates with the OpenRouter editor model", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    const { model } = mocks.generateObject.mock.calls[0][0];
    expect(model.modelId).toBe("openai/gpt-5.4-mini");
    expect(model.provider).toBe("openai.chat");
  });

  it("generates on the user's default key when one is set", async () => {
    mocks.query.mockResolvedValue({ key: openAiKey, modelId: "gpt-5.6-sol" });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    const { model } = mocks.generateObject.mock.calls[0][0];
    expect(model.modelId).toBe("gpt-5.4-mini");
    expect(model.provider).toBe("openai.responses");
  });

  it("returns a typed 422 when the provider refuses the default key", async () => {
    mocks.query.mockResolvedValue({ key: openAiKey, modelId: "gpt-5.6-sol" });
    mocks.generateObject.mockRejectedValue(new Error("Incorrect API key provided"));

    const res = await call();

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("Work key key was rejected"),
      code: "provider_key",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));

import { POST as suggestionPOST } from "./suggestion/route";
import { POST as quickEditPOST } from "./quick-edit/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/editor", {
    method: "POST",
    body: JSON.stringify(body),
  });

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
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.generateObject.mockResolvedValue({ object: result });
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
});

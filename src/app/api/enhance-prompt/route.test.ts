import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));

import {
  ENHANCE_PROMPT_RATE_LIMIT,
  resetRateLimits,
} from "@/features/integrations/server/rate-limit";

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/enhance-prompt", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const SPEC = {
  summary: "A todo app for individuals to track daily tasks.",
  pages: ["Tasks: the list of todos", "Settings: theme"],
  features: ["Add, edit and delete tasks", "Mark tasks done"],
  style: "Clean and minimal, light theme",
  data: "Tasks stored per user",
};

describe("POST /api/enhance-prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetRateLimits();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_ENHANCE_PROMPT_MODEL", "");
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.generateObject.mockResolvedValue({ object: SPEC });
  });

  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });

    const res = await post({ prompt: "todo app" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("returns a 503 JSON error when OpenRouter is not configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const res = await post({ prompt: "todo app" });

    expect(res.status).toBe(503);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt", async () => {
    const res = await post({ prompt: "   " });

    expect(res.status).toBe(400);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("returns 422 and never calls the model for credential-looking input", async () => {
    const res = await post({
      prompt: "todo app with key ghp_abcdefghijklmnopqrstuvwxyz123456",
    });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("credential_detected");
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("returns the spec as editable text, using the cheap editor model", async () => {
    const res = await post({ prompt: "todo app" });

    expect(res.status).toBe(200);
    const { prompt } = await res.json();
    expect(prompt).toContain(SPEC.summary);
    expect(prompt).toContain("Pages:\n- Tasks: the list of todos");
    expect(prompt).toContain("Features:\n- Add, edit and delete tasks");
    expect(prompt).toContain(`Style: ${SPEC.style}`);
    expect(prompt).toContain(`Data: ${SPEC.data}`);

    const { model, prompt: sent } = mocks.generateObject.mock.calls[0][0];
    expect(model.modelId).toBe("openai/gpt-5.4-mini");
    expect(model.provider).toBe("openai.chat");
    expect(sent).toContain("todo app");
  });

  it("returns 500 JSON when generation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.generateObject.mockRejectedValue(new Error("boom"));

    const res = await post({ prompt: "todo app" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to enhance prompt" });
  });

  it("rate limits per user", async () => {
    for (let i = 0; i < ENHANCE_PROMPT_RATE_LIMIT.limit; i++) {
      expect((await post({ prompt: "todo app" })).status).toBe(200);
    }

    const res = await post({ prompt: "todo app" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

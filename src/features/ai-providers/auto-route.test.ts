import { describe, expect, it } from "vitest";

import { AGENT_MODELS } from "../conversations/agent-models";
import { buildPlanMessage } from "../conversations/plan-mode";
import type { ModelAccess } from "./catalog";
import {
  EDIT_MAX_CHARS,
  MODEL_ROUTES,
  type RunTask,
  autoRouteModel,
  classifyRun,
} from "./auto-route";

const send = (overrides: Partial<Parameters<typeof classifyRun>[0]> = {}) =>
  classifyRun({
    planMode: false,
    hasImages: false,
    projectHasFiles: true,
    message: "Make the header blue",
    ...overrides,
  });

describe("classifyRun", () => {
  it.each<[string, Partial<Parameters<typeof classifyRun>[0]>, RunTask]>([
    ["plan mode", { planMode: true }, "plan"],
    ["plan mode with images", { planMode: true, hasImages: true }, "plan"],
    ["plan mode in an empty project", { planMode: true, projectHasFiles: false }, "plan"],
    ["an image edit", { hasImages: true }, "vision"],
    ["images with a fix request", { hasImages: true, source: "fix" }, "vision"],
    ["a fix request", { source: "fix" }, "fix"],
    ["a short fix request in an empty project", { source: "fix", projectHasFiles: false }, "fix"],
    ["a short first message in an empty project", { projectHasFiles: false }, "build"],
    ["a short follow-up", {}, "edit"],
    ["a follow-up just under the edit limit", { message: "x".repeat(EDIT_MAX_CHARS - 1) }, "edit"],
    ["a follow-up at the edit limit", { message: "x".repeat(EDIT_MAX_CHARS) }, "build"],
    ["an accepted short plan", { message: buildPlanMessage("- [ ] Add a footer") }, "build"],
  ])("routes %s to %s", (_, overrides, task) => {
    expect(send(overrides)).toBe(task);
  });
});

describe("MODEL_ROUTES", () => {
  const allowlist = new Map<string, { vision: boolean }>(AGENT_MODELS.map((model) => [model.id, model]));

  it("only routes to allowlisted models", () => {
    for (const ids of Object.values(MODEL_ROUTES)) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(allowlist.has(id), id).toBe(true);
    }
  });

  it("only routes image sends to vision models", () => {
    for (const id of MODEL_ROUTES.vision) expect(allowlist.get(id)?.vision, id).toBe(true);
  });
});

describe("autoRouteModel", () => {
  const model = (id: string, extra: { access?: ModelAccess; hidden?: boolean } = {}) => ({
    id,
    access: "everyone" as ModelAccess,
    hidden: false,
    ...extra,
  });

  it("picks the task's first route model the catalog offers", () => {
    const models = [model("openai/gpt-6.1-sol"), model("anthropic/claude-sonnet-5.5"), model("openai/gpt-6-luna")];
    expect(autoRouteModel(models, "build")?.id).toBe("anthropic/claude-sonnet-5.5");
    expect(autoRouteModel(models, "edit")?.id).toBe("openai/gpt-6-luna");
  });

  it("falls back past hidden and promo models, never routing to them", () => {
    const models = [
      model("anthropic/claude-sonnet-5.5", { access: "promo_unlimited" }),
      model("openai/gpt-6.1-sol"),
      model("openai/gpt-6-luna", { hidden: true }),
      model("google/gemini-3.8-flash"),
    ];
    expect(autoRouteModel(models, "plan")?.id).toBe("openai/gpt-6.1-sol");
    expect(autoRouteModel(models, "edit")?.id).toBe("google/gemini-3.8-flash");
  });

  it("finds nothing when the catalog has none of the route's models", () => {
    expect(autoRouteModel([model("x-ai/grok-4.7")], "build")).toBeUndefined();
  });
});

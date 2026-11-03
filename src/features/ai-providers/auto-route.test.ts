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
    firstBuild: false,
    message: "Make the header blue",
    ...overrides,
  });

describe("classifyRun", () => {
  it.each<[string, Partial<Parameters<typeof classifyRun>[0]>, RunTask]>([
    ["plan mode", { planMode: true }, "plan"],
    ["plan mode with images", { planMode: true, hasImages: true }, "plan"],
    ["plan mode before the first build", { planMode: true, firstBuild: true }, "plan"],
    ["an image edit", { hasImages: true }, "vision"],
    ["images with a fix request", { hasImages: true, source: "fix" }, "vision"],
    ["a fix request", { source: "fix" }, "fix"],
    ["a short fix request before the first build", { source: "fix", firstBuild: true }, "fix"],
    ["a short first message in an empty project", { firstBuild: true }, "build"],
    ["a short retry in a seeded project whose first run didn't finish", { firstBuild: true, message: "try again" }, "build"],
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
  const model = (
    id: string,
    extra: { access?: ModelAccess; hidden?: boolean; vision?: boolean; usd?: number } = {},
  ) => {
    const { usd = 1, ...rest } = extra;
    return {
      id,
      access: "everyone" as ModelAccess,
      hidden: false,
      vision: false,
      pricing: { mode: "blended" as const, usdPerMTok: usd },
      ...rest,
    };
  };

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

  it("routes image sends past a non-vision route model to a vision one", () => {
    const models = [
      model("anthropic/claude-sonnet-5.5"),
      model("google/gemini-3.8-flash", { vision: true }),
    ];
    expect(autoRouteModel(models, "vision")?.id).toBe("google/gemini-3.8-flash");
    expect(autoRouteModel(models.slice(0, 1), "vision")).toBeUndefined();
  });

  describe("with an admin pool", () => {
    const models = [
      model("cheap", { usd: 0.5 }),
      model("mid", { usd: 4, vision: true }),
      model("top", { usd: 12 }),
      model("top-twin", { usd: 12 }),
      model("anthropic/claude-sonnet-5.5", { usd: 6, vision: true }),
    ];
    const pool = ["cheap", "mid", "top", "top-twin"];

    it("sends builds, plans and fixes to the priciest, edits to the cheapest", () => {
      for (const task of ["build", "plan", "fix"] as const) {
        expect(autoRouteModel(models, task, pool)?.id, task).toBe("top");
      }
      expect(autoRouteModel(models, "edit", pool)?.id).toBe("cheap");
    });

    it("sends images only to the pool's vision models", () => {
      expect(autoRouteModel(models, "vision", pool)?.id).toBe("mid");
      // A vision model outside the pool is never used.
      expect(autoRouteModel(models, "vision", ["cheap", "top"])).toBeUndefined();
    });

    it("skips hidden, promo and removed members", () => {
      const gated = [
        model("top", { usd: 12, hidden: true }),
        model("mid", { usd: 4, access: "promo_counted" }),
        model("cheap", { usd: 0.5 }),
      ];
      expect(autoRouteModel(gated, "build", ["gone", "top", "mid", "cheap"])?.id).toBe("cheap");
    });

    it("falls back to the fixed routes when no member is usable or it's empty", () => {
      for (const empty of [[], ["gone"], undefined]) {
        expect(autoRouteModel(models, "build", empty)?.id).toBe("anthropic/claude-sonnet-5.5");
      }
    });
  });
});

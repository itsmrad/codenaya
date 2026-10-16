import { describe, it, expect } from "vitest";
import {
  ALL_STEPS,
  STEP_TITLES,
  getActiveFlow,
  getNextValidStep,
  type StepKey,
} from "../types";

describe("Onboarding types and flow logic", () => {
  it("defines all steps and corresponding titles", () => {
    expect(ALL_STEPS).toEqual([
      "welcome",
      "features",
      "auth",
      "github",
      "model",
      "project",
    ]);

    for (const step of ALL_STEPS) {
      expect(STEP_TITLES[step]).toBeDefined();
      expect(typeof STEP_TITLES[step]).toBe("string");
    }
  });

  describe("getActiveFlow", () => {
    it("includes all 6 steps when user is unauthenticated", () => {
      const flow = getActiveFlow(null, false, false);
      expect(flow).toEqual([
        "welcome",
        "features",
        "auth",
        "github",
        "model",
        "project",
      ]);
      expect(flow.length).toBe(6);
    });

    it("skips auth step when user is already signed in", () => {
      const flow = getActiveFlow("email", true, false);
      expect(flow).toEqual([
        "welcome",
        "features",
        "github",
        "model",
        "project",
      ]);
      expect(flow).not.toContain("auth");
      expect(flow.length).toBe(5);
    });

    it("keeps github step in flow even when github is already connected", () => {
      const flow = getActiveFlow("github", true, true);
      expect(flow).toContain("github");
      expect(flow).toEqual([
        "welcome",
        "features",
        "github",
        "model",
        "project",
      ]);
    });
  });

  describe("getNextValidStep", () => {
    const unauthedFlow: StepKey[] = [
      "welcome",
      "features",
      "auth",
      "github",
      "model",
      "project",
    ];
    const authedFlow: StepKey[] = [
      "welcome",
      "features",
      "github",
      "model",
      "project",
    ];

    it("retains the current step if it is already in the active flow", () => {
      expect(getNextValidStep("welcome", authedFlow)).toBe("welcome");
      expect(getNextValidStep("auth", unauthedFlow)).toBe("auth");
      expect(getNextValidStep("github", authedFlow)).toBe("github");
      expect(getNextValidStep("model", authedFlow)).toBe("model");
      expect(getNextValidStep("project", authedFlow)).toBe("project");
    });

    it("advances to github step when auth step is completed and removed from flow", () => {
      // User was on "auth", finished signing in, so "auth" is no longer in authedFlow.
      // It should advance to "github", NOT reset to "welcome".
      expect(getNextValidStep("auth", authedFlow)).toBe("github");
    });

    it("falls back safely if a non-existent step is passed", () => {
      expect(getNextValidStep("unknown" as StepKey, authedFlow)).toBe("welcome");
    });
  });
});

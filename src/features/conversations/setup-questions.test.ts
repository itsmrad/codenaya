import { describe, expect, test } from "vitest";

import { MAX_PROJECT_INSTRUCTIONS_LENGTH, buildProjectInstructionsSection } from "@/features/projects/instructions";

import {
  SETUP_QUESTIONS,
  shouldAskSetupQuestions,
  withSetupAnswers,
  withSetupDecisions,
} from "./setup-questions";

const answers = { audience: "A small team", style: "Minimal" };

describe("shouldAskSetupQuestions", () => {
  test("asks on a short prompt, not on a detailed one or an empty one", () => {
    expect(shouldAskSetupQuestions("a CRM")).toBe(true);
    expect(shouldAskSetupQuestions("a habit tracker for my family with streaks")).toBe(true);
    expect(
      shouldAskSetupQuestions(
        "Build a habit tracker for small teams with a weekly dashboard, streaks per person, reminders by email and a minimal black and white look",
      ),
    ).toBe(false);
    expect(shouldAskSetupQuestions("   ")).toBe(false);
  });
});

describe("the question set", () => {
  test("has at most 3 questions of at most 4 options", () => {
    expect(SETUP_QUESTIONS.length).toBeLessThanOrEqual(3);
    for (const question of SETUP_QUESTIONS) expect(question.options.length).toBeLessThanOrEqual(4);
  });
});

describe("withSetupAnswers", () => {
  test("adds the answered questions below the prompt", () => {
    expect(withSetupAnswers("a CRM", answers)).toBe(
      "a CRM\n\nDecisions from setup:\n- Audience: A small team\n- Style: Minimal",
    );
  });

  test("Skip (or nothing picked) sends the prompt unchanged", () => {
    expect(withSetupAnswers("a CRM", null)).toBe("a CRM");
    expect(withSetupAnswers("a CRM", {})).toBe("a CRM");
  });
});

describe("withSetupDecisions", () => {
  test("appends under the heading, keeping the owner's text", () => {
    expect(withSetupDecisions("Use TypeScript.", answers)).toBe(
      "Use TypeScript.\n\n## Decisions from setup\n- Audience: A small team\n- Style: Minimal",
    );
    expect(withSetupDecisions(undefined, answers)).toBe("## Decisions from setup\n- Audience: A small team\n- Style: Minimal");
  });

  test("adds nothing on Skip or past the instructions limit", () => {
    expect(withSetupDecisions("Use TypeScript.", null)).toBeNull();
    expect(withSetupDecisions("x".repeat(MAX_PROJECT_INSTRUCTIONS_LENGTH - 10), answers)).toBeNull();
  });

  test("the next run's prompt includes the saved decisions", () => {
    const section = buildProjectInstructionsSection(withSetupDecisions(undefined, answers)!);
    expect(section).toContain("## Decisions from setup\n- Audience: A small team\n- Style: Minimal");
  });
});

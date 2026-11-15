import { describe, expect, test } from "vitest";

import { MAX_PROJECT_INSTRUCTIONS_LENGTH, buildProjectInstructionsSection } from "@/features/projects/instructions";
import { MAX_PROMPT_LENGTH } from "@/lib/prompt-limit";

import {
  SETUP_QUESTIONS,
  shouldAskSetupQuestions,
  withSetupAnswers,
  withSetupDecisions,
} from "./setup-questions";

const answers = { audience: "A small team", style: "Minimal" };

describe("shouldAskSetupQuestions", () => {
  test("asks only under 8 words, never on an empty prompt", () => {
    expect(shouldAskSetupQuestions("a CRM")).toBe(true);
    expect(shouldAskSetupQuestions("habit tracker for runners")).toBe(true);
    expect(shouldAskSetupQuestions("a habit tracker for my running club")).toBe(true); // 7 words
    expect(shouldAskSetupQuestions("a todo app with dark mode and login")).toBe(false); // 8 words
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

  test("leaves the answers out rather than pass the prompt limit", () => {
    const long = "x".repeat(MAX_PROMPT_LENGTH - 10);
    expect(withSetupAnswers(long, answers)).toBe(long);
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

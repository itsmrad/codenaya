import { describe, expect, test } from "vitest";

import { MAX_PROJECT_INSTRUCTIONS_LENGTH, buildProjectInstructionsSection } from "@/features/projects/instructions";
import { MAX_PROMPT_LENGTH } from "@/lib/prompt-limit";

import {
  DECIDE_LATER,
  MAX_SETUP_QUESTIONS,
  setupQuestionsFor,
  withSetupAnswers,
  withSetupDecisions,
} from "./setup-questions";

const answers = { audience: "A small team", style: "Minimal" };
const ids = (prompt: string) => setupQuestionsFor(prompt).map(({ id }) => id);

const PIZZERIA =
  "Build a website for my pizzeria with the menu, a photo gallery, online table reservations and a contact form";

describe("setupQuestionsFor", () => {
  test("a short prompt gets audience, first screen and style; an empty one nothing", () => {
    expect(ids("a CRM")).toEqual(["data", "audience", "focus", "style"]);
    expect(ids("habit tracker for runners")).toEqual(["audience", "focus", "style"]);
    expect(ids("a habit tracker for my running club")).toEqual(["audience", "focus", "style"]); // 7 words
    expect(ids("   ")).toEqual([]);
  });

  test("a detailed prompt with no services, or an e2e smoke prompt, builds straight away", () => {
    expect(ids("a todo app with dark mode and keyboard shortcuts")).toEqual([]);
    expect(ids("e2e dashboard smoke: reply OK and change nothing.")).toEqual([]);
    expect(ids("e2e landing smoke: reply OK and change nothing.")).toEqual([]);
  });

  test("the pizzeria spec asks where reservations go and where it's hosted", () => {
    const questions = setupQuestionsFor(PIZZERIA);
    expect(questions.map(({ id }) => id)).toEqual(["data", "hosting"]);
    expect(questions[0]).toMatchObject({ recommended: "Supabase", options: ["Supabase", "Convex", "Just email me", DECIDE_LATER] });
    expect(questions[1]).toMatchObject({ recommended: "Codenaya publish" });
  });

  test("payments only when the prompt sells something", () => {
    expect(ids(`${PIZZERIA} and online orders with checkout`)).toContain("payments");
  });

  test("the payments question names no provider", () => {
    const payments = setupQuestionsFor("a shop site with checkout").find(({ id }) => id === "payments");
    expect(payments).toMatchObject({ recommended: "Yes, add a payment step", options: ["Yes, add a payment step", "Not now", DECIDE_LATER] });
    expect(JSON.stringify(payments)).not.toMatch(/stripe|paypal/i);
  });

  test("no question names a payment provider", () => {
    const all = setupQuestionsFor("an online store with a cart, checkout, subscriptions, donations and tickets");
    expect(all.map(({ id }) => id)).toContain("payments");
    expect(JSON.stringify(all)).not.toMatch(/stripe|paypal/i);
  });

  test("at most 4 questions of at most 4 options, each service with a recommendation and Decide later", () => {
    const all = setupQuestionsFor("a shop site with checkout, member login, email reminders, analytics and a booking form");
    expect(all).toHaveLength(MAX_SETUP_QUESTIONS);
    for (const question of all) {
      expect(question.options.length).toBeLessThanOrEqual(4);
      expect(question.options).toContain(DECIDE_LATER);
      expect(question.options).toContain(question.recommended);
    }
  });
});

describe("withSetupAnswers", () => {
  test("adds the answered questions below the prompt", () => {
    expect(withSetupAnswers("a CRM", answers)).toBe(
      "a CRM\n\nDecisions from setup:\n- Audience: A small team\n- Style: Minimal",
    );
  });

  test("folds service choices in, Decide later as not chosen", () => {
    expect(withSetupAnswers("pizzeria site", { data: "Supabase", hosting: DECIDE_LATER })).toBe(
      "pizzeria site\n\nDecisions from setup:\n- Data storage: Supabase\n- Hosting: not chosen yet; don't wire a provider",
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

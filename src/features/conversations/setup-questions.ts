import { MAX_PROJECT_INSTRUCTIONS_LENGTH } from "@/features/projects/instructions";

/**
 * Clarifying questions before the first build of an empty project (#344): a
 * fixed set, asked in the client before a short first prompt is sent. Pure, so
 * the rules are unit-tested.
 * shortcut: the questions are fixed, not written for the prompt; an `askUser`
 * agent tool can replace them later (#344, option A).
 */

export interface SetupQuestion {
  id: string;
  /** Shown above the chips and used as the answer's label. */
  label: string;
  topic: string;
  options: readonly string[];
}

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  { id: "audience", label: "Who is it for?", topic: "Audience", options: ["Just me", "A small team", "My customers", "Anyone online"] },
  { id: "focus", label: "What should the first screen be?", topic: "First screen", options: ["A dashboard", "A list to manage", "A landing page", "A form or tool"] },
  { id: "style", label: "What style?", topic: "Style", options: ["Minimal", "Bold and colorful", "Playful", "Professional"] },
];

/** Prompts this short leave the big decisions open, so they get questions. */
export const SETUP_QUESTIONS_MAX_WORDS = 15;

export const shouldAskSetupQuestions = (prompt: string) => {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  return words > 0 && words < SETUP_QUESTIONS_MAX_WORDS;
};

/** Question id → chosen option. Unanswered questions are left out. */
export type SetupAnswers = Record<string, string>;

const decisionLines = (answers: SetupAnswers) =>
  SETUP_QUESTIONS.filter(({ id }) => answers[id]).map(({ id, topic }) => `- ${topic}: ${answers[id]}`);

const HEADING = "Decisions from setup";

/** The first prompt with the answers below it; unchanged when there are none (Skip). */
export function withSetupAnswers(prompt: string, answers: SetupAnswers | null): string {
  const lines = answers ? decisionLines(answers) : [];
  return lines.length ? `${prompt}\n\n${HEADING}:\n${lines.join("\n")}` : prompt;
}

/**
 * The project instructions with the answers appended under "Decisions from
 * setup", never replacing the owner's text. Null when there is nothing to add,
 * or when it would pass the instructions limit (the first prompt still has them).
 */
export function withSetupDecisions(instructions: string | undefined, answers: SetupAnswers | null): string | null {
  const lines = answers ? decisionLines(answers) : [];
  if (!lines.length) return null;
  const section = `## ${HEADING}\n${lines.join("\n")}`;
  const existing = instructions?.trim();
  const next = existing ? `${existing}\n\n${section}` : section;
  return next.length > MAX_PROJECT_INSTRUCTIONS_LENGTH ? null : next;
}

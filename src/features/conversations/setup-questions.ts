import { MAX_PROJECT_INSTRUCTIONS_LENGTH } from "@/features/projects/instructions";
import { MAX_PROMPT_LENGTH } from "@/lib/prompt-limit";

/**
 * Clarifying questions before the first build of an empty project (#344): the
 * services the prompt implies (a keyword classifier), plus audience, first
 * screen and style for a short prompt. Asked in the client before the first
 * prompt is sent. Pure, so the rules are unit-tested.
 * shortcut: keyword matching, not a model; misses unusual wording. An `askUser`
 * agent tool can replace it later (#344, option A).
 */

export interface SetupQuestion {
  id: string;
  /** Shown above the chips and used as the answer's label. */
  label: string;
  topic: string;
  options: readonly string[];
  /** Picked up front; the owner can change it or Skip. */
  recommended?: string;
}

export const DECIDE_LATER = "Decide later";

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  { id: "audience", label: "Who is it for?", topic: "Audience", options: ["Just me", "A small team", "My customers", "Anyone online"] },
  { id: "focus", label: "What should the first screen be?", topic: "First screen", options: ["A dashboard", "A list to manage", "A landing page", "A form or tool"] },
  { id: "style", label: "What style?", topic: "Style", options: ["Minimal", "Bold and colorful", "Playful", "Professional"] },
];

/** A service the app needs, and the words that imply it. Most important first. */
const NEEDS: readonly (SetupQuestion & { match: RegExp })[] = [
  {
    id: "data",
    label: "Where should form entries, bookings and other data be saved?",
    topic: "Data storage",
    options: ["Supabase", "Convex", "Just email me", DECIDE_LATER],
    recommended: "Supabase",
    match: /\b(reserv\w*|book(ing|ings)?\b|appointments?|schedul\w*|forms?|contact|sign[- ]?ups?|waitlist|newsletter|inventory|database|crm|submissions?|rsvp|guestbook|comments?)\b/i,
  },
  {
    id: "payments",
    label: "Take online payments?",
    topic: "Payments",
    options: ["Stripe", "Not now", DECIDE_LATER],
    recommended: "Stripe",
    match: /\b(pay(ment|ments|ing)?|checkout|cart|e-?commerce|shop|online store|sell\w*|subscriptions?|donat\w*|tickets?|deposits?|order online|online orders?)\b/i,
  },
  {
    id: "auth",
    label: "Should people sign in?",
    topic: "Sign-in",
    options: ["Supabase Auth", "No sign-in", DECIDE_LATER],
    recommended: "Supabase Auth",
    match: /\b(log ?in|sign ?in|accounts?|members?(hip)?|auth\w*|user profiles?|admin (panel|area|dashboard))\b/i,
  },
  {
    id: "hosting",
    label: "Where will you host it?",
    topic: "Hosting",
    // Vercel only records the choice: it has no connect action (#540).
    options: ["Codenaya publish", "Netlify", "Vercel", DECIDE_LATER],
    recommended: "Codenaya publish",
    match: /\b(website|web ?site|site|landing page|portfolio|homepage|domain|restaurant|pizzeria|cafe|bakery|salon|clinic|studio|agency|my business|small business|publish|host\w*|deploy\w*|go live)\b/i,
  },
  {
    id: "email",
    label: "Send emails (confirmations, reminders)?",
    topic: "Email",
    options: ["Resend", "Not now", DECIDE_LATER],
    recommended: "Resend",
    match: /\b(e-?mails?|newsletter|reminders?|notif\w*|confirmations?)\b/i,
  },
  {
    id: "analytics",
    label: "Track visitors?",
    topic: "Analytics",
    options: ["PostHog", "Not now", DECIDE_LATER],
    recommended: "PostHog",
    match: /\b(analytics|track (visitors|traffic|usage)|metrics|page views)\b/i,
  },
];

export const MAX_SETUP_QUESTIONS = 4;

/**
 * Prompts with fewer words than this ("a CRM", "habit tracker for runners")
 * leave the big decisions open, so they get audience, screen and style too.
 */
export const SETUP_QUESTIONS_WORD_LIMIT = 8;

const isShort = (prompt: string) => prompt.trim().split(/\s+/).filter(Boolean).length < SETUP_QUESTIONS_WORD_LIMIT;

/**
 * The questions for a first prompt, at most 4: the services it implies first,
 * then the short-prompt ones. Empty means build straight away.
 */
export function setupQuestionsFor(prompt: string): SetupQuestion[] {
  if (!prompt.trim()) return [];
  const needs: SetupQuestion[] = NEEDS.filter(({ match }) => match.test(prompt));
  return [...needs, ...(isShort(prompt) ? SETUP_QUESTIONS : [])].slice(0, MAX_SETUP_QUESTIONS);
}

/** Question id → chosen option. Unanswered questions are left out. */
export type SetupAnswers = Record<string, string>;

const TOPICS = new Map([...SETUP_QUESTIONS, ...NEEDS].map(({ id, topic }) => [id, topic]));

const decisionLines = (answers: SetupAnswers) =>
  [...TOPICS]
    .filter(([id]) => answers[id])
    .map(([id, topic]) => `- ${topic}: ${answers[id] === DECIDE_LATER ? "decide later (leave a clear placeholder)" : answers[id]}`);

const HEADING = "Decisions from setup";

/**
 * The first prompt with the answers below it, as part of the request text;
 * unchanged when there are none (Skip), or when they'd push it past the
 * routes' prompt limit.
 */
export function withSetupAnswers(prompt: string, answers: SetupAnswers | null): string {
  const lines = answers ? decisionLines(answers) : [];
  const next = lines.length ? `${prompt}\n\n${HEADING}:\n${lines.join("\n")}` : prompt;
  return next.length > MAX_PROMPT_LENGTH ? prompt : next;
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

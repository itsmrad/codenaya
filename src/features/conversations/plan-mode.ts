import { withErrorHints } from "../sandbox-preview/utils/error-recipes";
import { STUCK_REASONS, type StuckRun } from "./agent-steps";

/**
 * Ask / Plan mode (#120, #311): the agent answers a question or replies with a
 * build plan, and changes nothing. Shared by the composer, the messages route
 * and both message processors.
 */

/** Sent with a message to run it in plan mode; omitted means build. */
export const PLAN_MODE = "plan";
export type MessageMode = typeof PLAN_MODE | "swarm";

/**
 * The only tools a plan-mode run gets, by name: reading the project and the
 * web, and loading skills. An allowlist, so no file, env var or integration
 * tool (which may write to an external service) can slip in.
 */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "listFiles",
  "readFiles",
  "searchFiles",
  "scrapeUrls",
  "loadSkill",
]);

export const PLAN_MODE_PROMPT = `

## Ask / Plan mode
This run is read-only. Do NOT create, edit, rename or delete files, and do not write code. You can only read: list, search and read the project's files, read URLs and load skills. Integration tools are unavailable.

If the user asks a question (what something does, why something happens, where something lives), answer it directly in Markdown, naming the files you looked at where useful. Do not write a plan for a question.

If the user asks for something to be built or changed, reply with a short build plan in Markdown, and nothing else:
- One sentence on what will be built.
- "### Pages", "### Components", "### Data" and "### Steps" sections, each a checklist of "- [ ] " items. Leave out a section that does not apply.
- Keep it under 25 items. Ask at most one question, at the end, only if the request is ambiguous.

The user will review the plan and click "Build this plan" to have it built.`;

// A section title line: "### Steps", "## 1. Steps:", "**Steps**", "### **Data**".
const PLAN_SECTION =
  /^(?:#{1,4}\s+(?:\*\*)?|\*\*)(?:\d+[.)]\s*)?(?:Pages|Components|Data|Steps):?(?:\*\*)?:?\s*$/im;
const PLAN_ITEM = /^\s*[-*] \[ \] /m;

/** A reply is a plan, not an answer, when it has a plan section and a checklist (#311). */
export const isPlanReply = (content: string) =>
  PLAN_SECTION.test(content) && PLAN_ITEM.test(content);

/** The build request sent when the user accepts a plan. */
export const buildPlanMessage = (plan: string) => `Build this plan:\n\n${plan}`;

/** The build request for a plan the user edited (#527); null when it is empty. */
export const editedPlanMessage = (plan: string) =>
  plan.trim() ? buildPlanMessage(plan.trim()) : null;

/**
 * The plan-mode message "Diagnose in Ask / Plan mode" pre-fills for a stuck run
 * (#306), with the likely cause of a known error (#334).
 */
export const diagnoseStuckMessage = (
  stuck: Pick<StuckRun, "reason" | "error">,
  filePath?: string,
) =>
  [
    `The last run got stuck: ${STUCK_REASONS[stuck.reason]}.`,
    stuck.error && withErrorHints(`The error:\n${stuck.error}`),
    filePath && `File: ${filePath}`,
    "Find the root cause before changing anything, and plan a different approach.",
  ]
    .filter(Boolean)
    .join("\n\n");

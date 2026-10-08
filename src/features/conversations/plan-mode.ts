/**
 * Plan mode (#120): the agent replies with a build plan and changes nothing.
 * Shared by the composer, the messages route and both message processors.
 */

/** Sent with a message to run it in plan mode; omitted means build. */
export const PLAN_MODE = "plan";
export type MessageMode = typeof PLAN_MODE;

/**
 * The only tools a plan-mode run gets, by name: reading the project and the
 * web, and loading skills. An allowlist, so no file, env var or integration
 * tool (which may write to an external service) can slip in.
 */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "listFiles",
  "readFiles",
  "scrapeUrls",
  "loadSkill",
]);

export const PLAN_MODE_PROMPT = `

## Plan mode
The user wants a plan before anything is built. Do NOT create, edit, rename or delete files, and do not write code. You can only read: list and read the project's files, read URLs and load skills. Integration tools are unavailable.

Reply with a short build plan in Markdown, and nothing else:
- One sentence on what will be built.
- "### Pages", "### Components", "### Data" and "### Steps" sections, each a checklist of "- [ ] " items. Leave out a section that does not apply.
- Keep it under 25 items. Ask at most one question, at the end, only if the request is ambiguous.

The user will review the plan and click "Build this plan" to have it built.`;

/** The build request sent when the user accepts a plan. */
export const buildPlanMessage = (plan: string) => `Build this plan:\n\n${plan}`;

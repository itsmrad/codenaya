// Re-export the existing prompts so the workflow feature folder is fully
// self-contained at the API level, even though the underlying constants live
// next to the legacy Inngest implementation. Keeping a single source of truth
// avoids prompt drift between the two backends.
export {
  CODING_AGENT_SYSTEM_PROMPT,
  TITLE_GENERATOR_SYSTEM_PROMPT,
} from "../inngest/constants";

export const WORKFLOW_MAX_STEPS = 30;

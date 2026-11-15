import { PROMO_REFUSAL_MESSAGES } from "@/features/promotions/github-promo";

import { LOST_RUN_MESSAGE } from "./agent-steps";

/**
 * The replies a run stores when it failed. Pure, so the chat can tell a failed
 * run too (#257); the server modules that write them re-export their own.
 */

/** The reply `processMessage` stores when a run fails. */
export const AGENT_FAILURE_MESSAGE =
  "My apologies, I encountered an error while processing your request. Let me know if you need anything else!";

/** Sent to the user when the platform has no key. The env var name is logged, not sent. */
export const AI_NOT_CONFIGURED_MESSAGE =
  "Codenaya AI isn't available right now. Try again later, or add your own key in Settings → AI providers.";

/** Written in place of the reply when the agent could not be started. */
export const DISPATCH_FAILED_MESSAGE =
  "I couldn't start working on this because the agent service is unreachable. Please try again in a moment.";

/** Ends every key-failure reply, so history can leave those turns out. */
export const KEY_FAILURE_SUFFIX = "Your request was not sent to Codenaya's models.";

/** A reply that says the run failed rather than answering. */
export const isFailedRunReply = (content: string) =>
  content === AGENT_FAILURE_MESSAGE ||
  content === LOST_RUN_MESSAGE ||
  content === AI_NOT_CONFIGURED_MESSAGE ||
  Object.values(PROMO_REFUSAL_MESSAGES).includes(content) ||
  content === DISPATCH_FAILED_MESSAGE ||
  content.endsWith(KEY_FAILURE_SUFFIX);

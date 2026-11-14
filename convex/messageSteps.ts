import type { Infer } from "convex/values";
import type { messageStepValidator } from "./schema";

// Keeps each agent's step trail and document bounded on long runs.
export const MAX_MESSAGE_STEPS = 100;
type MessageStep = Infer<typeof messageStepValidator>;

/** Merge by tool call id, preserving omitted fields and the original start. */
export function mergeMessageSteps(existing: MessageStep[], incoming: MessageStep[]): MessageStep[] {
  const steps = [...existing];
  for (const step of incoming) {
    const index = steps.findIndex((recorded) => recorded.id === step.id);
    if (index === -1) {
      steps.push(step);
    } else {
      steps[index] = { ...steps[index], ...step, startedAt: steps[index].startedAt };
    }
  }
  return steps.slice(-MAX_MESSAGE_STEPS);
}

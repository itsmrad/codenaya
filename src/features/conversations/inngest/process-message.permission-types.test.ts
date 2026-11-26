import type { GetFunctionInput } from "inngest";
import { expectTypeOf, it } from "vitest";

import type { Doc } from "../../../../convex/_generated/dataModel";
import type { processMessage } from "./process-message";

// Compile the real workflow's step signature without running a workflow or provider.
async function messageStepTypes(
  step: GetFunctionInput<typeof processMessage>["step"],
  readMessage: () => Promise<Doc<"messages"> | null>,
  readMessages: () => Promise<Doc<"messages">[]>,
) {
  const message = await step.run("typed-message", readMessage);
  const messages = await step.run("typed-messages", readMessages);
  expectTypeOf(message).toMatchTypeOf<Doc<"messages"> | null>();
  expectTypeOf(messages).toMatchTypeOf<Doc<"messages">[]>();
}

it("retains document types through permission middleware", () => {
  expectTypeOf(messageStepTypes).toBeFunction();
});

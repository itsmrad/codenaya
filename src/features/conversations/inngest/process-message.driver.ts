/**
 * Runs the real `processMessage` function under Inngest's execution engine,
 * replayed the way the platform does it (see step-isolation.test.ts for the
 * rationale). Test files mock Convex with `vi.mock` before importing this.
 */

import { StepMode } from "inngest/types";

import { inngest } from "@/inngest/client";

import { processMessage } from "./process-message";

export const text = (content: string) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
});

/** One inference result: memoized data, or a failed AI gateway step. */
export type Inference = { data: unknown } | { error: unknown };

export interface Outcome {
  finalType: string;
  /** Every persisted step result (what Inngest stores). */
  stepState: Record<string, unknown>;
  /** URLs the AI gateway was asked to call. */
  inferenceUrls: string[];
  /** The request bodies sent with them. */
  inferenceBodies: unknown[];
}

export async function drive(
  model: Record<string, unknown>,
  inferences: Inference[],
  message = "List my files",
  /** More event fields, such as `mode`. */
  extra: Record<string, unknown> = {},
): Promise<Outcome> {
  const event = {
    name: "message/sent",
    data: {
      messageId: "m1",
      conversationId: "c1",
      projectId: "p1",
      message,
      model,
      ...extra,
    },
  };
  const stepState: Record<string, unknown> = {};
  const order: string[] = [];
  const inferenceUrls: string[] = [];
  const inferenceBodies: unknown[] = [];
  let next = 0;

  for (let request = 0; request < 100; request += 1) {
    const execution = (
      processMessage as unknown as {
        createExecution: (o: { partialOptions: Record<string, unknown> }) => {
          start: () => Promise<Record<string, unknown>>;
        };
      }
    ).createExecution({
      partialOptions: {
        client: inngest,
        runId: "run-under-test",
        stepMode: StepMode.Async,
        data: { event, events: [event], runId: "run-under-test", attempt: 0 },
        stepState: { ...stepState },
        stepCompletionOrder: [...order],
        reqArgs: [],
        headers: {},
      },
    });

    const result = (await execution.start()) as {
      type: string;
      step?: { id: string; data?: unknown; error?: unknown };
      steps?: Array<{ id: string; op?: string; opts?: { url?: string; body?: unknown } }>;
    };

    if (result.type === "step-ran" && result.step) {
      const { id, data, error } = result.step;
      stepState[id] = { id, ...(error ? { error } : { data }) };
      order.push(id);
      continue;
    }

    if (result.type === "steps-found" && result.steps) {
      for (const found of result.steps) {
        if (found.op === "AIGateway") {
          inferenceUrls.push(found.opts?.url ?? "");
          inferenceBodies.push(found.opts?.body);
          stepState[found.id] = { id: found.id, ...inferences[Math.min(next++, inferences.length - 1)] };
        } else if (found.op === "Sleep") {
          stepState[found.id] = { id: found.id, data: null };
        } else {
          throw new Error(`Unexpected op ${found.op}`);
        }
        order.push(found.id);
      }
      continue;
    }

    return { finalType: result.type, stepState, inferenceUrls, inferenceBodies };
  }
  throw new Error("Function did not settle");
}

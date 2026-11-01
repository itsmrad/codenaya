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

export const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
});

/**
 * One inference result: memoized data, or a failed AI gateway step. A `held`
 * one resolves only once nothing else can run, so it finishes after the rest.
 */
export type Inference = ({ data: unknown } | { error: unknown }) & { held?: boolean };

export interface Outcome {
  finalType: string;
  /** Every persisted step result (what Inngest stores). */
  stepState: Record<string, unknown>;
  /** URLs the AI gateway was asked to call. */
  inferenceUrls: string[];
  /** The request bodies sent with them. */
  inferenceBodies: unknown[];
  /** Which function invocation found each one: equal means requested together. */
  inferenceRequests: number[];
  /** Which invocation's result resolved each one (undefined: never). */
  inferenceResolvedAt: Array<number | undefined>;
}

export async function drive(
  model: Record<string, unknown>,
  inferences: Inference[],
  message = "List my files",
  /** More event fields, such as `mode`. */
  extra: Record<string, unknown> = {},
  /** `cancelWhen`: stop between steps once it holds, like `cancelOn` (finalType "cancelled"). */
  { cancelWhen }: { cancelWhen?: () => boolean } = {},
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
  const inferenceRequests: number[] = [];
  const assigned = new Map<string, number>();
  const inferenceResolvedAt: Array<number | undefined> = [];
  const outcome = (finalType: string): Outcome => ({
    finalType,
    stepState,
    inferenceUrls,
    inferenceBodies,
    inferenceRequests,
    inferenceResolvedAt,
  });

  for (let request = 0, requestedRunStep: string | undefined; request < 100; request += 1) {
    if (cancelWhen?.()) {
      return outcome("cancelled");
    }
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
        requestedRunStep,
        reqArgs: [],
        headers: {},
      },
    });

    const result = (await execution.start()) as {
      type: string;
      step?: { id: string; data?: unknown; error?: unknown };
      steps?: Array<{ id: string; op?: string; opts?: { url?: string; body?: unknown } }>;
    };

    requestedRunStep = undefined;

    if (result.type === "step-ran" && result.step) {
      const { id, data, error } = result.step;
      stepState[id] = { id, ...(error ? { error } : { data }) };
      order.push(id);
      continue;
    }

    if (result.type === "steps-found" && result.steps) {
      const gateways = result.steps.filter((found) => found.op === "AIGateway");
      for (const found of gateways) {
        if (assigned.has(found.id)) continue;
        assigned.set(found.id, inferenceRequests.length);
        inferenceResolvedAt.push(undefined);
        inferenceUrls.push(found.opts?.url ?? "");
        inferenceBodies.push(found.opts?.body);
        inferenceRequests.push(request);
      }
      // Parallel step.run calls come back planned; like the platform, ask for
      // one at a time (the title runs alongside the coding agent, #338).
      const planned = result.steps.find((found) => found.op === "StepPlanned");
      if (planned) {
        requestedRunStep = planned.id;
        continue;
      }
      const unexpected = result.steps.find((found) => found.op !== "AIGateway");
      if (unexpected) throw new Error(`Unexpected op ${unexpected.op}`);

      const inferenceOf = (id: string) =>
        inferences[Math.min(assigned.get(id)!, inferences.length - 1)];
      const ready = gateways.filter((found) => !inferenceOf(found.id).held);
      for (const found of ready.length > 0 ? ready : gateways) {
        const inference = inferenceOf(found.id);
        stepState[found.id] = {
          id: found.id,
          ...("data" in inference ? { data: inference.data } : { error: inference.error }),
        };
        inferenceResolvedAt[assigned.get(found.id)!] = request;
        order.push(found.id);
      }
      continue;
    }

    return outcome(result.type);
  }
  throw new Error("Function did not settle");
}

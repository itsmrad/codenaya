import type { GetStepTools } from "inngest";

import type { RunModel } from "@/features/ai-providers/server/resolve-run-model";
import type { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";

import { type UsageStatus, monthKey, usageLimitMessage } from "../limits";
import { usageFromRaw } from "../usage-from-raw";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Platform AI usage for one agent run: a cap check before the first model
 * call, then one record per call. Each is a step, so a replay reuses its
 * result; and each record's key is fixed per call (`<runId>:t<turn>`), so a
 * step that re-executes after an Inngest retry is deduped in Convex.
 */
export function createRunUsageMeter({
  step,
  internalKey,
  runId,
  messageId,
  userId,
  platform,
}: {
  step: GetStepTools<typeof inngest>;
  internalKey: string;
  runId: string;
  messageId: Id<"messages">;
  userId: string;
  platform: NonNullable<RunModel["platform"]>;
}) {
  let exceeded: UsageStatus | undefined;

  return {
    /** Set once a recorded call reached a cap: make no further model calls. */
    get exceeded() {
      return exceeded;
    },

    /**
     * True when the user was already over a cap as the run starts (it queued
     * behind their other runs, or the route's check raced); the reply then
     * says which cap and how to keep going.
     */
    blockedAtStart: () =>
      step.run("check-usage-limit", async () => {
        const month = monthKey();
        const status = await convex.query(api.aiUsage.checkLimit, { internalKey, userId, month });
        if (!status.exceeded) return false;
        await convex.mutation(api.system.updateMessageContent, {
          internalKey,
          messageId,
          content: usageLimitMessage(status, month),
        });
        return true;
      }),

    /** Meters one model call, on the coding or the title model, from its raw provider response. */
    record: async (call: string, source: "agent" | "title", raw: string | undefined) => {
      const { inputTokens, outputTokens } = usageFromRaw(raw);
      const status = await step.run("record-usage", () =>
        convex.mutation(api.aiUsage.record, {
          internalKey,
          key: `${runId}:${call}`,
          userId,
          source,
          provider: platform.provider,
          modelId: source === "title" ? platform.titleModelId : platform.codingModelId,
          inputTokens,
          outputTokens,
        }),
      );
      if (status.exceeded) exceeded = status;
    },
  };
}

/** Appended to a reply the cap cut short. */
export const stoppedByLimitNote = (status: UsageStatus) =>
  `**Stopped: monthly AI limit reached.** ${usageLimitMessage(status, monthKey())}`;

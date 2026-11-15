import { readFile } from "node:fs/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { appendLedger, tokenCost } from "./cost";

const verdictSchema = z.object({
  items: z.array(z.object({ item: z.string(), verdict: z.enum(["pass", "fail", "unknown"]), note: z.string() })),
  score: z.number().int().min(1).max(10).describe("Quality of what the screenshot shows, 1 (broken) to 10 (polished, complete)"),
});

/** Judge full-page app screenshots, one per captured route, against the prompt's rubric. */
export async function judge(run: string, model: string, prompt: string, rubric: string[], shots: { route: string; path: string }[]) {
  // No temperature: Haiku 5.5 rejects non-default values. A fixed prompt and schema keep verdicts stable.
  const { object, usage } = await generateObject({
    model: createAnthropic()(model),
    schema: verdictSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `You grade an AI-built web app from full-page screenshots, one per route, each labelled with its route. Captured routes: ${shots.map((s) => s.route).join(", ")}.\n\n<prompt>\n${prompt}\n</prompt>\n\nFor each rubric item, in order: pass when a screenshot shows it, fail when it should be visible on a captured route but is missing or broken, unknown when it needs interaction (a later step, a click, a reload) a screenshot cannot show, or when it belongs on a route that was not captured (never fail for that). Score only what is visible. Rubric:\n${rubric.map((item) => `- ${item}`).join("\n")}` },
        ...(await Promise.all(shots.map(async (s) => [
          { type: "text" as const, text: `Route ${s.route}:` },
          { type: "image" as const, image: await readFile(s.path), mediaType: "image/png" },
        ]))).flat(),
      ],
    }],
  });
  const tokensIn = usage.inputTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const usd = tokenCost(model, tokensIn, tokensOut);
  await appendLedger({ at: new Date().toISOString(), run: `${run}/judge`, provider: "anthropic", model, tokens_in: tokensIn, tokens_out: tokensOut, usd });
  return { model, ...object, passed: object.items.filter((i) => i.verdict === "pass").length, total: object.items.filter((i) => i.verdict !== "unknown").length, tokensIn, tokensOut, usd };
}

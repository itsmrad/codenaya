import { readFile } from "node:fs/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { appendLedger, tokenCost } from "./cost";

const verdictSchema = z.object({
  items: z.array(z.object({ item: z.string(), verdict: z.enum(["pass", "fail", "unknown"]), note: z.string() })),
  score: z.number().int().min(1).max(10).describe("Quality of what the screenshot shows, 1 (broken) to 10 (polished, complete)"),
});

/** Judge a full-page app screenshot against the prompt's rubric. */
export async function judge(run: string, model: string, prompt: string, rubric: string[], screenshotPath: string) {
  // No temperature: Haiku 5.5 rejects non-default values. A fixed prompt and schema keep verdicts stable.
  const { object, usage } = await generateObject({
    model: createAnthropic()(model),
    schema: verdictSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `You grade an AI-built web app from a full-page screenshot of its first screen.\n\n<prompt>\n${prompt}\n</prompt>\n\nFor each rubric item, in order: pass when the screenshot shows it, fail when it should be visible on this screen but is missing or broken, unknown when it needs interaction (a later step, a click, a reload) the screenshot cannot show. Score only what is visible. Rubric:\n${rubric.map((item) => `- ${item}`).join("\n")}` },
        { type: "image", image: await readFile(screenshotPath), mediaType: "image/png" },
      ],
    }],
  });
  const tokensIn = usage.inputTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const usd = tokenCost(model, tokensIn, tokensOut);
  await appendLedger({ at: new Date().toISOString(), run: `${run}/judge`, provider: "anthropic", model, tokens_in: tokensIn, tokens_out: tokensOut, usd });
  return { model, ...object, passed: object.items.filter((i) => i.verdict === "pass").length, total: object.items.filter((i) => i.verdict !== "unknown").length, tokensIn, tokensOut, usd };
}

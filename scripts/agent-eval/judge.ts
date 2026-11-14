import { readFile } from "node:fs/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { appendLedger, tokenCost } from "./cost";

const verdictSchema = z.object({
  items: z.array(z.object({ item: z.string(), pass: z.boolean(), note: z.string() })),
  score: z.number().int().min(1).max(10).describe("Overall quality, 1 (broken) to 10 (polished, complete)"),
});

/** Judge a full-page app screenshot against the prompt's rubric. */
export async function judge(run: string, model: string, prompt: string, rubric: string[], screenshotPath: string) {
  const { object, usage } = await generateObject({
    model: createAnthropic()(model),
    schema: verdictSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `You grade an AI-built web app from a full-page screenshot of its first screen.\n\n<prompt>\n${prompt}\n</prompt>\n\nFor each rubric item, in order, say pass only when the screenshot shows it (interactive behaviour you cannot see fails unless its visible controls are present). Rubric:\n${rubric.map((item) => `- ${item}`).join("\n")}` },
        { type: "image", image: await readFile(screenshotPath), mediaType: "image/png" },
      ],
    }],
  });
  const tokensIn = usage.inputTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const usd = tokenCost(model, tokensIn, tokensOut);
  await appendLedger({ at: new Date().toISOString(), run: `${run}/judge`, provider: "anthropic", model, tokens_in: tokensIn, tokens_out: tokensOut, usd });
  return { model, ...object, passed: object.items.filter((i) => i.pass).length, total: rubric.length, tokensIn, tokensOut, usd };
}

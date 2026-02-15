import { inngest } from "@/inngest/client";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

export const demoGenerate = inngest.createFunction(
  { id: "demo-generate" },
  { event: "demo/generate" },
  async ({ step }) => {
    await step.run("generate-text", async () => {
      return await generateText({
        model: openai('gpt-3.5-turbo'),
        prompt: 'write a vegeterian lasagna recipe for 4 people'
      })
    })
  },
);
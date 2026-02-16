import { inngest } from "@/inngest/client";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { firecrawl } from "@/lib/firecrawl"

const URL_REGEX = /https?:\/\/[^\s]+/g;

export const demoGenerate = inngest.createFunction(
  { id: "demo-generate" },
  { event: "demo/generate" },
  async ({ event,  step }) => {
    const { prompt } = event.data as { prompt: string}

    const urls = await step.run("extract-urls", async () => {
      return prompt.match(URL_REGEX) ?? []
    }) as string[];

    const scrapedContent = await step.run("scrape-urls", async () => {
      const results = await Promise.all(
        urls.map(async (url) => {
          const result = await firecrawl.scrape(
            url,
            { formats: ['markdown']}
          )
          return result.markdown ?? null
        })
      )
      return results.filter(Boolean).join("\n\n")
    })

    const finalPrompt = scrapedContent
      ? `Context: \n${scrapedContent}\n\n${prompt}`
      : prompt;

    await step.run("generate-text", async () => {
      return await generateText({
        model: openai('gpt-3.5-turbo'),
        prompt: finalPrompt
      })
    })
  },
);
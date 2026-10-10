import { createOpenAI } from "@ai-sdk/openai";

const provider = createOpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL,
  apiKey: process.env.OPENROUTER_API_KEY,
});

// OpenRouter speaks Chat Completions, not the OpenAI Responses API
export const openrouter = (model = process.env.OPENROUTER_MODEL ?? "openrouter/free") =>
  provider.chat(model);

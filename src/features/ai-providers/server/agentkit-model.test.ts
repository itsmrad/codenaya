import { createAgenticModelFromAiAdapter, createTool } from "@inngest/agent-kit";
import { afterEach, describe, expect, it } from "vitest";

import { AI_PROVIDERS } from "../registry";
import { buildAgentKitModel, withoutToolCalls } from "./agentkit-model";

const tool = createTool({ name: "listFiles", description: "List files", handler: () => [] });

/** The request body AgentKit builds for a model, after the model's own hook. */
const requestBody = (model: ReturnType<typeof buildAgentKitModel>, tools = [tool]) => {
  const body = createAgenticModelFromAiAdapter(model).requestParser(
    model,
    [{ type: "text", role: "user", content: "hi" }],
    tools,
    "auto",
  ) as Record<string, unknown>;
  (model.onCall as (adapter: unknown, body: unknown) => void)(model, body);
  return body;
};

const openrouter = () =>
  buildAgentKitModel({ provider: "openrouter", apiKey: "sk-or", model: "x-ai/grok-4.7" });

afterEach(() => {
  delete AI_PROVIDERS.custom.parallelToolCalls;
});

describe("parallel tool calls", () => {
  it("allows several tool calls per turn on an OpenAI-format provider", () => {
    expect(requestBody(openrouter())).toMatchObject({ parallel_tool_calls: true, tool_choice: "auto" });
  });

  it("leaves the parameter out of a request without tools", () => {
    expect(requestBody(openrouter(), [])).not.toHaveProperty("parallel_tool_calls");
  });

  it("omits the parameter for a provider with the flag off", () => {
    AI_PROVIDERS.custom.parallelToolCalls = false;
    const model = buildAgentKitModel({
      provider: "custom",
      apiKey: "k",
      baseUrl: "https://llm.example.com/v1",
      model: "m",
    });
    const body = requestBody(model);
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.tools).toHaveLength(1);
  });
});

describe("withoutToolCalls", () => {
  it("keeps the tools but forbids calling them", () => {
    const body = requestBody(withoutToolCalls(openrouter()));
    expect(body).toMatchObject({ tool_choice: "none", model: "x-ai/grok-4.7" });
    expect(body.tools).toHaveLength(1);
  });

  it("uses Anthropic's form on the native adapter", () => {
    const model = buildAgentKitModel({ provider: "anthropic", apiKey: "sk-ant", model: "claude-opus-5-5" });
    expect(requestBody(withoutToolCalls(model))).toMatchObject({ tool_choice: { type: "none" } });
  });
});

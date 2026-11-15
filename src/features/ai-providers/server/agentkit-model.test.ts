import { createAgenticModelFromAiAdapter, createTool } from "@inngest/agent-kit";
import { afterEach, describe, expect, it } from "vitest";

import { AI_PROVIDERS } from "../registry";
import { SWARM_DELEGATE_NUDGE } from "@/features/conversations/inngest/constants";
import { createDelegateTasksTool } from "@/features/conversations/inngest/tools/delegate-tasks";

import { buildAgentKitModel, forceToolCall, toolForcing, withoutToolCalls } from "./agentkit-model";

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

describe("forceToolCall", () => {
  const anthropicKey = (model: string) => buildAgentKitModel({ provider: "anthropic", apiKey: "sk-ant", model });
  const routed = (model: string) => buildAgentKitModel({ provider: "openrouter", apiKey: "sk-or", model });

  it("decides per route: Claude thinks by default and only Haiku can turn it off", () => {
    expect(toolForcing(buildAgentKitModel({ provider: "openai", apiKey: "k", model: "gpt-6.1" }))).toBe("force");
    expect(toolForcing(buildAgentKitModel({ provider: "openai", apiKey: "k", model: "o5-mini" }))).toBe("force");
    expect(toolForcing(buildAgentKitModel({ provider: "groq", apiKey: "k", model: "openai/gpt-oss-120b" }))).toBe("force");
    // Not an OpenAI-family model on an official host: OpenRouter, a custom endpoint even at openrouter.ai, other models.
    expect(toolForcing(routed("x-ai/grok-4.7"))).toBe("auto");
    expect(toolForcing(routed("openai/gpt-6.1"))).toBe("auto");
    expect(toolForcing(buildAgentKitModel({ provider: "groq", apiKey: "k", model: "llama-4-70b" }))).toBe("auto");
    expect(toolForcing(buildAgentKitModel({ provider: "custom", apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "x-ai/grok-4.7" }))).toBe("auto");
    expect(toolForcing(routed("anthropic/claude-opus-5.5"))).toBe("auto");
    expect(toolForcing(anthropicKey("claude-opus-5-5"))).toBe("auto");
    expect(toolForcing(routed("anthropic/claude-haiku-5.5"))).toBe("force-thinking-off");
    expect(toolForcing(anthropicKey("claude-haiku-5-5"))).toBe("force-thinking-off");
    expect(toolForcing(buildAgentKitModel({ provider: "custom", apiKey: "k", baseUrl: "https://llm.example.com/v1", model: "m" }))).toBe("auto");
  });

  it("forces the tool for an OpenAI model on its official host, and leaves other routes on auto", () => {
    expect(requestBody(forceToolCall(buildAgentKitModel({ provider: "openai", apiKey: "k", model: "gpt-6.1" }), "listFiles")))
      .toMatchObject({ tool_choice: { type: "function", function: { name: "listFiles" } } });
    expect(requestBody(forceToolCall(routed("x-ai/grok-4.7"), "listFiles"))).toMatchObject({ tool_choice: "auto" });
  });

  it("turns thinking off where it forces a Claude model", () => {
    expect(requestBody(forceToolCall(anthropicKey("claude-haiku-5-5"), "listFiles")))
      .toMatchObject({ tool_choice: { type: "tool", name: "listFiles" }, thinking: { type: "disabled" } });
    expect(requestBody(forceToolCall(routed("anthropic/claude-haiku-5.5"), "listFiles")))
      .toMatchObject({ tool_choice: { type: "function", function: { name: "listFiles" } }, reasoning: { enabled: false } });
  });

  // The forced turn's exact request on the two thinking routes, for a live replay (keys are headers, not body).
  it.each([
    ["openrouter-claude-opus-5.5", routed("anthropic/claude-opus-5.5")],
    ["anthropic-claude-opus-5-5", anthropicKey("claude-opus-5-5")],
  ])("never forces a thinking Claude model (%s): auto with the nudge", async (name, model) => {
    const delegate = createDelegateTasksTool({
      internalKey: "ik", projectId: "p1" as never, messageId: "m1" as never, ownerId: "user_1", model: { modelId: "m" },
    });
    const body = createAgenticModelFromAiAdapter(forceToolCall(model, "delegateTasks")).requestParser(
      model,
      [
        { type: "text", role: "user", content: "Build a pizzeria site with home, menu, about and contact pages" },
        { type: "text", role: "user", content: SWARM_DELEGATE_NUDGE },
      ],
      [delegate],
      "auto",
    ) as Record<string, unknown>;
    (forceToolCall(model, "delegateTasks").onCall as (adapter: unknown, body: unknown) => void)(model, body);
    expect(JSON.stringify(body.tool_choice)).toMatch(/^("auto"|\{"type":"auto"\})$/);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning");
    await expect(`${JSON.stringify(body, null, 2)}\n`).toMatchFileSnapshot(`./__fixtures__/forced-turn-${name}.json`);
  });
});

import { createAgenticModelFromAiAdapter, createTool, type Message } from "@inngest/agent-kit";
import { afterEach, describe, expect, it } from "vitest";

import { AI_PROVIDERS } from "../registry";
import { SWARM_DELEGATE_NUDGE } from "@/features/conversations/inngest/constants";
import { createDelegateTasksTool } from "@/features/conversations/inngest/tools/delegate-tasks";

import { buildAgentKitModel, forceToolCall, toolForcing, withoutToolCalls, withPromptCache } from "./agentkit-model";

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

describe("withPromptCache", () => {
  const BASE = "BASE PROMPT, the same for every run.\n";
  const TREE = "## Project files\nsrc/App.tsx\n";
  const tools = [tool, createTool({ name: "readFiles", description: "Read files", handler: () => [] })];
  const call = { type: "tool" as const, id: "call-1", name: "readFiles", input: { paths: ["src/App.tsx"] } };
  const step1: Message[] = [
    { type: "text", role: "system", content: BASE + TREE },
    { type: "text", role: "user", content: "Build a pizzeria site" },
  ];
  const step2: Message[] = [
    ...step1,
    { type: "tool_call", role: "assistant", tools: [call], stop_reason: "tool" },
    { type: "tool_result", role: "tool_result", tool: call, content: { data: "export default App" }, stop_reason: "tool" },
  ];

  type Body = Record<string, unknown> & { system?: unknown; messages: { content: unknown }[]; tools?: unknown[] };
  const body = (model: ReturnType<typeof buildAgentKitModel>, messages: Message[]) => {
    const request = createAgenticModelFromAiAdapter(model).requestParser(model, messages, tools, "auto") as unknown as Body;
    (model.onCall as (adapter: unknown, body: unknown) => void)(model, request);
    return request;
  };
  const claude = () =>
    withPromptCache(buildAgentKitModel({ provider: "anthropic", apiKey: "sk-ant", model: "claude-haiku-5-5" }), BASE);
  const breakpoints = (value: unknown) => JSON.stringify(value).split('"cache_control"').length - 1;
  /** The request as the cache sees it: breakpoints mark where to cache, they are not content. */
  const content = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v)));

  it("marks the last tool, the shared system prefix and the last two messages on Anthropic", () => {
    const request = body(claude(), step2);
    expect(breakpoints(request)).toBe(4);
    expect(request.tools?.map((t) => "cache_control" in (t as object))).toEqual([false, true]);
    expect(request.system).toEqual([
      { type: "text", text: BASE, cache_control: { type: "ephemeral" } },
      { type: "text", text: TREE },
    ]);
    const marked = request.messages.map((m) => breakpoints(m));
    expect(marked).toEqual([0, 1, 1]);
    expect(request.messages[2].content).toEqual([
      expect.objectContaining({ type: "tool_result", cache_control: { type: "ephemeral" } }),
    ]);
  });

  it("keeps the cached prefix byte-identical from one step to the next", () => {
    const first = body(claude(), step1);
    const second = body(claude(), step2);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
    // Step 1's last message, where it wrote the cache, starts step 2 unchanged.
    expect(content(second.messages.slice(0, first.messages.length))).toEqual(content(first.messages));
    expect(breakpoints(first.messages.at(-1))).toBe(1);
  });

  it("caches the whole system prompt when it does not start with the shared prefix", () => {
    const request = body(withPromptCache(buildAgentKitModel({ provider: "anthropic", apiKey: "k", model: "claude-opus-5-5" }), "OTHER"), step1);
    expect(request.system).toEqual([{ type: "text", text: BASE + TREE, cache_control: { type: "ephemeral" } }]);
  });

  it("gives swarm workers one shared system block, with the task line after it", () => {
    const shared = `${BASE}\n\n${TREE}\n\n`;
    const worker = (title: string) => body(
      withPromptCache(buildAgentKitModel({ provider: "anthropic", apiKey: "k", model: "claude-haiku-5-5" }), shared),
      [{ type: "text", role: "system", content: `${shared}## Your task: ${title}` }, { type: "text", role: "user", content: title }],
    ).system as { text: string }[];
    const [a, b] = [worker("Header"), worker("Footer")];
    expect(JSON.stringify(a[0])).toBe(JSON.stringify(b[0]));
    expect(a[0]).toMatchObject({ text: shared, cache_control: { type: "ephemeral" } });
    expect([a[1].text, b[1].text]).toEqual(["## Your task: Header", "## Your task: Footer"]);
  });

  it("passes breakpoints through OpenRouter for Claude", () => {
    const model = withPromptCache(buildAgentKitModel({ provider: "openrouter", apiKey: "sk-or", model: "anthropic/claude-sonnet-5.5" }), BASE);
    const request = body(model, step2);
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.messages[0].content).toEqual([
      { type: "text", text: BASE, cache_control: { type: "ephemeral" } },
      { type: "text", text: TREE },
    ]);
    expect(breakpoints(request.tools)).toBe(0);
  });

  it("leaves other models' requests unchanged", () => {
    const model = buildAgentKitModel({ provider: "openrouter", apiKey: "sk-or", model: "x-ai/grok-4.7" });
    expect(withPromptCache(model, BASE)).toBe(model);
    expect(breakpoints(body(withPromptCache(model, BASE), step2))).toBe(0);
  });

  it("keeps its breakpoints under the tool-choice wrappers", () => {
    const request = body(withoutToolCalls(claude()), step2);
    expect(request.tool_choice).toEqual({ type: "none" });
    expect(breakpoints(request)).toBe(4);
  });
});

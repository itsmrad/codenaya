import { createAgenticModelFromAiAdapter } from "@inngest/agent-kit";
import { describe, expect, it } from "vitest";

import { buildAgentKitModel } from "./agentkit-model";

describe("AgentKit Anthropic response parsing", () => {
  it("skips thinking blocks and keeps text and tool calls", () => {
    const model = createAgenticModelFromAiAdapter(
      buildAgentKitModel({ provider: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5-5" }),
    );

    // Current Claude models interleave these with tool use. AgentKit 0.13.2 crashed on
    // them, and its types omit them, hence the cast.
    const output = model.responseParser({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "readFiles", input: { paths: ["a"] } },
      ],
    } as unknown as Parameters<typeof model.responseParser>[0]);

    expect(output).toEqual([
      { type: "text", role: "assistant", content: "hi", stop_reason: "stop" },
      {
        type: "tool_call",
        role: "assistant",
        stop_reason: "tool",
        tools: [{ type: "tool", id: "t1", name: "readFiles", input: { paths: ["a"] } }],
      },
    ]);
  });
});

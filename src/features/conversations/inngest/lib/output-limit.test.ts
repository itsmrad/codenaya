import { createTool, type AgentResult } from "@inngest/agent-kit";
import { describe, expect, it, vi } from "vitest";

import { WRITE_BATCH_FILES } from "../constants";
import {
  OUTPUT_LIMIT_ERROR,
  OUTPUT_LIMIT_NOTE,
  hitOutputLimit,
  markCutOffCalls,
  refuseCutOffCalls,
} from "./output-limit";

const raw = (body: unknown) => JSON.stringify(body);

describe("hitOutputLimit", () => {
  it("spots an Anthropic reply stopped by max_tokens", () => {
    expect(hitOutputLimit(raw({ role: "assistant", content: [], stop_reason: "max_tokens" }))).toBe(true);
  });

  it("spots an OpenAI-style reply stopped by length", () => {
    expect(
      hitOutputLimit(raw({ choices: [{ message: { role: "assistant" }, finish_reason: "length" }] })),
    ).toBe(true);
  });

  it.each([
    ["an Anthropic tool call", { stop_reason: "tool_use" }],
    ["an Anthropic answer", { stop_reason: "end_turn" }],
    ["an OpenAI tool call", { choices: [{ finish_reason: "tool_calls" }] }],
    ["an OpenAI answer", { choices: [{ finish_reason: "stop" }] }],
    ["a body without a stop reason", {}],
    ["null", null],
  ])("leaves %s alone", (_, body) => {
    expect(hitOutputLimit(raw(body))).toBe(false);
  });

  it("is false for a missing or unparsable raw response", () => {
    expect(hitOutputLimit(undefined)).toBe(false);
    expect(hitOutputLimit("not json")).toBe(false);
  });
});

describe("cut-off tool calls", () => {
  const tool = () => {
    const handler = vi.fn(async () => "written");
    return {
      handler,
      wrapped: refuseCutOffCalls(
        createTool({ name: "writeFiles", description: "Write files", handler }),
      ),
    };
  };
  const opts = {} as Parameters<ReturnType<typeof refuseCutOffCalls>["handler"]>[1];

  it("refuses every call of a cut-off reply, and serializes its input as {}", async () => {
    const output: AgentResult["output"] = [
      { type: "text", role: "assistant", content: "Writing the app", stop_reason: "stop" },
      {
        type: "tool_call",
        role: "assistant",
        stop_reason: "tool",
        tools: [
          { type: "tool", id: "t1", name: "writeFiles", input: { files: [{ path: "a.ts", content: "x" }] } },
          { type: "tool", id: "t2", name: "writeFiles", input: { files: [{ path: "b.ts", content: "exp" }] } },
        ],
      },
    ];
    markCutOffCalls(output);

    const { handler, wrapped } = tool();
    const calls = output.flatMap((m) => (m.type === "tool_call" ? m.tools : []));
    for (const call of calls) {
      expect(await wrapped.handler(call.input, opts)).toBe(OUTPUT_LIMIT_ERROR);
      expect(JSON.stringify(call.input)).toBe("{}");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs any other call, an empty input included", async () => {
    const { handler, wrapped } = tool();
    expect(await wrapped.handler({}, opts)).toBe("written");
    expect(handler).toHaveBeenCalledWith({}, opts);
  });

  it("keeps the tool's name, description and schema", () => {
    const { wrapped } = tool();
    expect(wrapped).toMatchObject({ name: "writeFiles", description: "Write files" });
  });

  it("tells the model why and how small to go, in the run block's error form", () => {
    expect(OUTPUT_LIMIT_ERROR).toMatch(/^Error: /);
    for (const text of [OUTPUT_LIMIT_ERROR, OUTPUT_LIMIT_NOTE]) {
      expect(text).toContain("output limit");
      expect(text).toContain(`at most ${WRITE_BATCH_FILES} files`);
    }
  });
});

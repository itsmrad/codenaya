import type { Tool } from "@inngest/agent-kit";
import { describe, expect, it, vi } from "vitest";

import { decodeJsonArgs } from "./json-args";
import { trimFileHistory, type HistoryMessage } from "./trim-file-history";

const fake = (name: string) => {
  const handler = vi.fn((input: unknown) => input);
  return { tool: decodeJsonArgs({ name, handler } as unknown as Tool.Any), handler };
};
const call = (tool: Tool.Any, input: unknown) => tool.handler(input as never, {} as never);

describe("decodeJsonArgs", () => {
  it("decodes a file tool's JSON-string array args in place", () => {
    const { tool } = fake("readFiles");
    const input = { paths: '["a.ts"]', ranges: '[{"path":"a.ts","startLine":1}]' };
    call(tool, input);
    expect(input).toEqual({ paths: ["a.ts"], ranges: [{ path: "a.ts", startLine: 1 }] });
  });

  it("leaves strings that aren't a JSON array or object, other params and other tools alone", () => {
    const edit = { path: '["not", "parsed"]', edits: "not json" };
    call(fake("editFile").tool, edit);
    expect(edit).toEqual({ path: '["not", "parsed"]', edits: "not json" });
    const scalar = { paths: "42" };
    call(fake("deleteFiles").tool, scalar);
    expect(scalar).toEqual({ paths: "42" });
    const other = { files: "[]" };
    call(fake("someMcpTool").tool, other);
    expect(other).toEqual({ files: "[]" });
  });

  it("leaves a string over the size cap for the normal validation error", () => {
    const files = JSON.stringify([{ path: "a.ts", content: "x".repeat(2_000_000) }]);
    const input = { files };
    call(fake("writeFiles").tool, input);
    expect(input.files).toBe(files);
  });

  it("passes a frozen input with none of its keys through untouched", () => {
    const { tool, handler } = fake("writeFiles");
    const frozen = Object.freeze({});
    call(tool, frozen);
    expect(handler).toHaveBeenCalledWith(frozen, {});
  });

  it("decodes the recorded tool call too, so old writes are trimmed from history", () => {
    const payload = "line\n".repeat(5000);
    const { tool } = fake("writeFiles");
    const history: HistoryMessage[] = Array.from({ length: 18 }, (_, i): HistoryMessage[] => {
      const call_ = { type: "tool" as const, id: `call_${i}`, name: "writeFiles", input: { files: JSON.stringify([{ path: "a.ts", content: payload }]) } };
      call(tool, call_.input);
      return [
        { type: "tool_call", role: "assistant", stop_reason: "tool", tools: [call_] },
        { type: "tool_result", role: "tool_result", stop_reason: "tool", tool: { type: "tool", id: call_.id, name: call_.name } as never, content: { data: "ok" } },
      ];
    }).flat();
    expect(JSON.stringify(trimFileHistory(history).slice(0, 24))).not.toContain(payload);
  });
});

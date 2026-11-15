import type { Tool } from "@inngest/agent-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

  it("decodes array args whose string values hold raw newlines, tabs and CRs", () => {
    const edits = '[\n  {\n    "oldText": "  \\"name\\": \\"app\\",\n",\n\t"newText": "a\tb\r\nc \\\\"\n  }\n]';
    const input = { path: "package.json", edits };
    call(fake("editFile").tool, input);
    expect(input.edits).toEqual([{ oldText: '  "name": "app",\n', newText: "a\tb\r\nc \\" }]);
    const files = { files: '[{"path":"src/index.css","content":"body {\n\tmargin: 0;\n}\n"}]' };
    call(fake("writeFiles").tool, files);
    expect(files.files).toEqual([{ path: "src/index.css", content: "body {\n\tmargin: 0;\n}\n" }]);
  });

  it("decodes double-encoded array args", () => {
    const value = [{ oldText: '"a": 1,\n', newText: '"a": 2,\n' }];
    const input = { edits: JSON.stringify(JSON.stringify(value)) };
    call(fake("editFile").tool, input);
    expect(input.edits).toEqual(value);
    const files = [{ path: "src/x.ts", content: "x\n" }];
    const write = { files: JSON.stringify(JSON.stringify(files)) };
    call(fake("writeFiles").tool, write);
    expect(write.files).toEqual(files);
  });

  it.each([false, true])("decodes XML-style keys with raw control chars: %s", (rawControlChars) => {
    const edits = [
      { oldText: "  --accent: var(--red);\n\t", newText: "  --accent: var(--blue);\n\t" },
      { oldText: "  --muted: var(--gray);", newText: "  --muted: var(--slate);" },
    ];
    let text = JSON.stringify(edits).replace(/"(oldText|newText)":"/g, '"$1">');
    if (rawControlChars) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const input = { edits: text };
    call(fake("editFile").tool, input);
    expect(input.edits).toEqual(edits);
  });

  it('preserves "> inside properly quoted string values', () => {
    const edits = [{ oldText: '<a title="old">', newText: '<a title="new">' }];
    const input = { edits: JSON.stringify(edits) };
    call(fake("editFile").tool, input);
    expect(input.edits).toEqual(edits);
  });

  it("warns once across equal replay inputs and leaves undecodable args invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tool } = fake("editFile");
    const input = { edits: '[{"oldText": secret}]' };
    call(tool, input);
    call(tool, input);
    call(tool, { ...input });
    expect(input.edits).toBe('[{"oldText": secret}]');
    expect(z.array(z.object({ oldText: z.string(), newText: z.string() })).safeParse(input.edits).success).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("editFile.edits");
    expect(logged).toContain('[{\\"xxxxxxx\\": xxxxxx}]');
    expect(logged).not.toContain("secret");
    warn.mockRestore();
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

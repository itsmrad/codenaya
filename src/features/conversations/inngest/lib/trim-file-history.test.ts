import { type ToolMessage, createAgenticModelFromAiAdapter } from "@inngest/agent-kit";
import { describe, expect, it } from "vitest";
import { buildAgentKitModel } from "@/features/ai-providers/server/agentkit-model";
import { FILE_HISTORY_THRESHOLD, trimFileHistory, type HistoryMessage } from "./trim-file-history";

const payload = "line\n".repeat(5000);
const turn = (i: number, name = "updateFile", input: Record<string, unknown> = { path: "a.ts", content: payload }, data: unknown = "ok"): HistoryMessage[] => {
  const tool = { type: "tool" as const, id: `call_${i}`, name, input };
  return [
    { type: "tool_call", role: "assistant", stop_reason: "tool", tools: [tool] },
    { type: "tool_result", role: "tool_result", stop_reason: "tool", tool: { type: tool.type, id: tool.id, name: tool.name } as ToolMessage, content: { data } },
  ];
};
const long = () => Array.from({ length: 18 }, (_, i) => turn(i)).flat();

describe("trimFileHistory", () => {
  it("leaves a small history untouched, and retains at least six full turns", () => {
    const small = turn(0);
    expect(trimFileHistory(small)).toBe(small);
    const hugeRecent = Array.from({ length: 6 }, (_, i) => turn(i, "updateFile", { fileId: "f1", content: payload.repeat(10) })).flat();
    expect(JSON.stringify(hugeRecent).length).toBeGreaterThan(FILE_HISTORY_THRESHOLD);
    expect(trimFileHistory(hugeRecent)).toBe(hugeRecent);
  });

  it("trims in six-turn chunks without mutating raw history or ordinary text", () => {
    const history = long();
    history.unshift({ type: "text", role: "user", content: "Keep this request" });
    const original = structuredClone(history);
    const trimmed = trimFileHistory(history);
    expect(history).toEqual(original);
    expect(trimmed[0]).toEqual(history[0]);
    expect(JSON.stringify(trimmed.slice(1, 25))).not.toContain(payload);
    expect(trimmed.slice(25)).toEqual(history.slice(25));
    const next = trimFileHistory([...history, ...turn(18)]);
    expect(next.slice(0, 25)).toEqual(trimmed.slice(0, 25));
    expect(trimFileHistory(structuredClone(history))).toEqual(trimmed);
  });

  it.each([
    ["updateFile", { fileId: "f1", content: payload }],
    ["updateFile", { path: "a.ts", content: payload }],
    ["createFiles", { parentId: "folder", files: [{ name: "a.ts", content: payload }] }],
    ["writeFiles", { files: [{ path: "a.ts", content: payload }] }],
    ["editFile", { path: "a.ts", edits: [{ oldText: payload, newText: payload }] }],
  ])("clears old %s payloads", (name, input) => {
    const trimmed = trimFileHistory([...turn(99, name, input), ...long()]);
    expect(JSON.stringify(trimmed.slice(0, 2))).not.toContain(payload);
    expect(JSON.stringify(trimmed.slice(0, 2))).toContain("re-read if needed");
  });

  it.each([
    [{ fileIds: ["f1"] }, JSON.stringify([{ id: "f1", name: "a.ts", content: payload }])],
    [{ paths: ["a.ts"] }, JSON.stringify([{ path: "a.ts", content: payload }])],
    [{ paths: ["a.ts"] }, `a.ts (lines 1-5000)\n1: ${payload}`],
  ])("clears old reads regardless of result format", (input, data) => {
    const trimmed = trimFileHistory([...turn(99, "readFiles", input, data), ...long()]);
    expect(JSON.stringify(trimmed.slice(0, 2))).not.toContain(payload);
    expect(JSON.stringify(trimmed.slice(0, 2))).toContain("re-read if needed");
  });

  it("preserves errors, unknown tools and unaddressed inputs", () => {
    const prefix = [
      ...turn(99, "readFiles", { paths: ["a.ts"] }, "Error: missing file"),
      ...turn(100, "mcp_write", { path: "a.ts", content: payload }),
      ...turn(101, "updateFile", { content: payload }),
      ...turn(102, "readFiles", {}, payload),
    ];
    expect(trimFileHistory([...prefix, ...long()]).slice(0, prefix.length)).toEqual(prefix);
  });

  it.each(["openai", "anthropic"] as const)("preserves call/result pairing through the %s adapter", (provider) => {
    const adapter = buildAgentKitModel({ provider, apiKey: "test", model: "test" });
    const model = createAgenticModelFromAiAdapter(adapter);
    const history = long();
    const before = model.requestParser(adapter, history, [], "auto");
    const after = model.requestParser(adapter, trimFileHistory(history), [], "auto");
    const ids = (body: unknown) => JSON.stringify(body).match(/call_\d+/g);
    expect(ids(after)).toEqual(ids(before));
    expect(JSON.stringify(after).length).toBeLessThan(JSON.stringify(before).length / 2);
  });
});

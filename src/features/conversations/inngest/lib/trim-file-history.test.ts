import { type ToolMessage, createAgenticModelFromAiAdapter } from "@inngest/agent-kit";
import { describe, expect, it } from "vitest";
import { buildAgentKitModel } from "@/features/ai-providers/server/agentkit-model";
import { FILE_HISTORY_THRESHOLD, MIN_CUT_TURNS, trimFileHistory, type HistoryMessage } from "./trim-file-history";

const payload = "line\n".repeat(5000);
const turn = (i: number, name = "updateFile", input: Record<string, unknown> | null = { path: "a.ts", content: payload }, data: unknown = "ok"): HistoryMessage[] => {
  const tool = { type: "tool" as const, id: `call_${i}`, name, input: input as ToolMessage["input"] };
  return [
    { type: "tool_call", role: "assistant", stop_reason: "tool", tools: [tool] },
    { type: "tool_result", role: "tool_result", stop_reason: "tool", tool: { type: tool.type, id: tool.id, name: tool.name } as ToolMessage, content: { data } },
  ];
};
const long = () => Array.from({ length: 18 }, (_, i) => turn(i)).flat();
const OMITTED = "; content omitted from history. Unchanged since unless a later turn changed it: re-read only if you need its exact text]";
const HASH = "hash [0-9a-f]{8}";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A stub: `[<detail>; content omitted ...]`, with `HASH` matching any hash in `detail`. */
const stub = (detail: string) => new RegExp(`^\\[${escape(detail).replace(escape(HASH), HASH)}${escape(OMITTED)}$`);
const resultData = (message: HistoryMessage) => {
  if (message.type !== "tool_result") throw new Error("Expected a tool result");
  return (message.content as { data: unknown }).data;
};

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
    expect(JSON.stringify(trimmed.slice(0, 2))).toContain("content omitted from history");
  });

  it.each([
    [{ fileIds: ["f1"] }, JSON.stringify([{ id: "f1", name: "a.ts", content: payload }])],
    [{ paths: ["a.ts"] }, JSON.stringify([{ path: "a.ts", content: payload }])],
    [{ paths: ["a.ts"] }, `a.ts (lines 1-5000)\n1: ${payload}`],
  ])("clears old reads regardless of result format", (input, data) => {
    const trimmed = trimFileHistory([...turn(99, "readFiles", input, data), ...long()]);
    expect(JSON.stringify(trimmed.slice(0, 2))).not.toContain(payload);
    expect(JSON.stringify(trimmed.slice(0, 2))).toContain("content omitted from history");
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

  it.each(["updateFile", "createFiles", "writeFiles", "editFile", "readFiles"])(
    "preserves null arguments for %s without crashing later turns", (name) => {
      const invalid = turn(99, name, null, "Error: invalid arguments");
      const history = [...invalid, ...long()];
      expect(trimFileHistory(history).slice(0, 2)).toEqual(invalid);
      expect(trimFileHistory([...history, ...turn(100)]).slice(0, 2)).toEqual(invalid);
    },
  );

  it("trims ranged-only reads using their paths", () => {
    const input = { ranges: [{ path: "range.ts", startLine: 1, endLine: 5000 }] };
    const trimmed = trimFileHistory([...turn(99, "readFiles", input, `range.ts\n1: ${payload}`), ...long()]);
    expect(resultData(trimmed[1])).toMatch(stub(`content of range.ts, ${HASH}`));
  });

  it("keeps error lines when read results mix JSON or numbered content with errors", () => {
    const errors = ["Error: missing a.ts", "Error reading files: access denied"];
    for (const data of [JSON.stringify([{ path: "a.ts", content: payload }]), `a.ts\n1: ${payload}`]) {
      const mixed = `${data}\n${errors.join("\n")}`;
      const trimmed = trimFileHistory([...turn(99, "readFiles", { paths: ["a.ts"] }, mixed), ...long()]);
      const [first, ...rest] = String(resultData(trimmed[1])).split("\n");
      expect(first).toMatch(stub(`content of a.ts, ${HASH}`));
      expect(rest).toEqual(errors);
    }
  });

  it.each([false, true])("keeps missing metadata in object reads (serialized: %s)", (serialized) => {
    const data = { files: [{ path: "a.ts", content: payload }], missing: ["missing.ts"] };
    const trimmed = trimFileHistory([
      ...turn(99, "readFiles", { paths: ["a.ts", "missing.ts"] }, serialized ? JSON.stringify(data) : data),
      ...long(),
    ]);
    const content = resultData(trimmed[1]);
    expect(serialized ? JSON.parse(content as string) : content).toEqual({
      ...data, files: [{ path: "a.ts", content: expect.stringMatching(stub(`content of a.ts, 5000 lines, ${HASH}`)) }],
    });
  });

  it("preserves AgentKit error payloads without adding a data field", () => {
    const failed = turn(99, "readFiles", { paths: ["a.ts"] });
    if (failed[1].type !== "tool_result") throw new Error("Expected a tool result");
    failed[1].content = { error: { message: "read failed" } };
    expect(trimFileHistory([...failed, ...long()])[1]).toEqual(failed[1]);
  });

  it("keeps recent reads intact even when a provider reuses an old call id", () => {
    const recent = turn(99, "readFiles", { paths: ["new.ts"] }, payload);
    const old = turn(99, "readFiles", { paths: ["old.ts"] }, payload);
    const trimmed = trimFileHistory([...old, ...long(), ...recent]);
    expect(trimmed.slice(-2)).toEqual(recent);
    expect(resultData(trimmed[1])).toMatch(stub(`content of old.ts, ${HASH}`));
  });

  it.each([["", 0], ["one", 1], ["one\n", 1], ["one\ntwo\n", 2]])(
    "counts %j correctly and describes supplied content without claiming a failed write succeeded", (content, lines) => {
      const error = "Error: write rejected";
      const trimmed = trimFileHistory([...turn(99, "updateFile", { path: "a.ts", content }, error), ...long()]);
      expect(trimmed[0].type === "tool_call" && trimmed[0].tools[0].input.content).toMatch(
        stub(`write supplied for a.ts, ${lines} lines, ${HASH}`),
      );
      expect(trimmed[1].type === "tool_result" && trimmed[1].content).toEqual({ data: error });
    },
  );

  it("keeps editFile edits shaped as an array", () => {
    const trimmed = trimFileHistory([
      ...turn(99, "editFile", { path: "a.ts", edits: [{ oldText: payload, newText: payload }] }), ...long(),
    ]);
    const edits = (trimmed[0].type === "tool_call" ? trimmed[0].tools[0].input.edits : undefined) as
      Array<{ oldText: string; newText: string }>;
    expect(edits).toEqual([{ oldText: expect.stringMatching(stub(`edits to a.ts, ${HASH}`)), newText: expect.any(String) }]);
    expect(edits[0].newText).toBe(edits[0].oldText);
  });

  it("keeps each request's history a byte-stable prefix of the next one between rare cuts", () => {
    const read = (i: number) => turn(i, "readFiles", { paths: [`f${i}.ts`] },
      JSON.stringify([{ path: `f${i}.ts`, content: `// file ${i}\n`.repeat(2000) }]));
    let history: HistoryMessage[] = [{ type: "text", role: "user", content: "Build it" }];
    let previous: HistoryMessage[] = [];
    const cuts: number[] = [];
    const frozen = new Map<number, string>();
    for (let i = 0; i < 48; i++) {
      history = [...history, ...read(i)];
      const view = trimFileHistory(history);
      if (JSON.stringify(view.slice(0, previous.length)) !== JSON.stringify(previous)) cuts.push(i);
      // A trimmed message never changes again.
      view.forEach((message, index) => {
        const json = JSON.stringify(message);
        if (json.includes("content omitted")) {
          expect(frozen.get(index) ?? json).toBe(json);
          frozen.set(index, json);
        }
      });
      // The newest turns are always whole.
      expect(view.slice(-12)).toEqual(history.slice(-12));
      previous = view;
    }
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.length).toBeLessThanOrEqual(Math.ceil(48 / MIN_CUT_TURNS));
    cuts.slice(1).forEach((cut, i) => expect(cut - cuts[i]).toBeGreaterThanOrEqual(MIN_CUT_TURNS));
  });

  it("never cuts a history that is long only because of text, so its cache prefix holds", () => {
    const chat: HistoryMessage[] = Array.from({ length: 20 }, (_, i): HistoryMessage[] => [
      { type: "text", role: "user", content: `request ${i} ${"words ".repeat(2000)}` },
      ...turn(i, "readFiles", { paths: ["a.ts"] }, JSON.stringify([{ path: "a.ts", content: "tiny" }])),
    ]).flat();
    expect(JSON.stringify(chat).length).toBeGreaterThan(FILE_HISTORY_THRESHOLD);
    expect(trimFileHistory(chat)).toBe(chat);
  });

  it("gives a file the same stub on every trim, naming its path, lines and a content hash", () => {
    const history = (content: string) => [
      ...turn(99, "readFiles", { paths: ["src/App.tsx"] }, JSON.stringify([{ path: "src/App.tsx", content }])),
      ...long(),
    ];
    const contentOf = (view: HistoryMessage[]) => JSON.parse(resultData(view[1]) as string)[0].content as string;
    const first = contentOf(trimFileHistory(history("a\nb\nc\n")));
    expect(first).toMatch(stub(`content of src/App.tsx, 3 lines, ${HASH}`));
    expect(contentOf(trimFileHistory(history("a\nb\nc\n")))).toBe(first);
    expect(contentOf(trimFileHistory([...history("a\nb\nc\n"), ...turn(200)]))).toBe(first);
    expect(contentOf(trimFileHistory(history("a\nb\nd\n")))).not.toBe(first);
  });

});

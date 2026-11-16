import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptComposer } from "./prompt-composer";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Select, SelectTrigger } from "@/components/ui/select";

const harness = vi.hoisted(() => {
  const states: unknown[] = [];
  let cursor = 0;
  return {
    states, effects: [] as (() => void)[],
    resetCursor: () => { cursor = 0; },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    },
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: harness.useState,
  useEffect: (effect: () => void) => harness.effects.push(effect),
  useRef: () => ({ current: null }),
}));
vi.mock("motion/react", () => ({ useReducedMotion: () => true }));
vi.mock("@/features/conversations/hooks/use-agent-model", () => ({ useAgentModel: () => [{ modelId: "model" }, vi.fn()] }));
vi.mock("@/features/conversations/hooks/use-agent-tasks", () => ({ useSwarmEnabled: () => false }));
vi.mock("@/features/conversations/hooks/use-enhance-prompt", () => ({ useEnhancePrompt: () => ({ isEnhancing: false }) }));
vi.mock("@/features/conversations/components/agent-model-select", () => ({ AgentModelSelect: "div" }));
vi.mock("@/features/conversations/components/enhance-prompt-button", () => ({ EnhancePromptButton: "button" }));
vi.mock("@/features/conversations/components/plan-mode-toggle", () => ({ PlanModeToggle: "mode-toggle" }));
vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: "form", PromptInputBody: "div", PromptInputFooter: "footer",
  PromptInputSubmit: "button", PromptInputSpeechButton: "button", PromptInputTextarea: "textarea", PromptInputTools: "prompt-tools",
}));

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> {
  if (isValidElement(node)) {
    if (node.type === type) return node as ReactElement<Record<string, unknown>>;
    for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
      const found = find(child, type);
      if (found) return found;
    }
  }
  return undefined!;
}

beforeEach(() => {
  harness.states.length = 0;
  harness.effects.length = 0;
  vi.clearAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

it.each(["A Next.js blog", "Use TanStack Start for a blog"])("lets the prompt decide: %s", async (prompt) => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const getItem = vi.fn().mockReturnValue("next");
  vi.stubGlobal("localStorage", { getItem });
  harness.resetCursor();
  const tree = PromptComposer({ onSubmit });
  for (const effect of harness.effects) effect();
  expect(find(tree, Select)).toBeUndefined();
  expect(find(tree, SelectTrigger)).toBeUndefined();
  await (find(tree, PromptInput).props.onSubmit as (message: { text: string }) => Promise<void>)({ text: prompt });
  expect(onSubmit).toHaveBeenCalledWith(prompt, "build", undefined);
  expect(getItem).not.toHaveBeenCalled();
});

it.each(["next", "vite", "tanstack-start"] as const)("passes through a landing/template framework: %s", async (initialFramework) => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  harness.resetCursor();
  const tree = PromptComposer({ onSubmit, initialFramework });
  expect(find(tree, Select)).toBeUndefined();
  await (find(tree, PromptInput).props.onSubmit as (message: { text: string }) => Promise<void>)({ text: "A blog" });
  expect(onSubmit).toHaveBeenCalledWith("A blog", "build", initialFramework);
});

it("places the toolbar immediately after the textarea without a framework row or Auto cell", () => {
  harness.resetCursor();
  const tree = PromptComposer({ onSubmit: vi.fn() });
  const rows = Children.toArray(find(tree, PromptInput).props.children as ReactNode);
  expect(rows).toHaveLength(2);
  expect((rows[0] as ReactElement).type).toBe(PromptInputBody);
  expect((rows[1] as ReactElement).type).toBe(PromptInputFooter);
  const tools = Children.toArray(find(tree, PromptInputTools).props.children as ReactNode);
  expect(tools).toHaveLength(4); // Enhance, speech, modes, agent model.
  expect(find(tools[2], "mode-toggle")).toBeDefined();
  expect(find(tree, Select)).toBeUndefined();
});

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { PromptComposer } from "./prompt-composer";
import { PromptInput, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Select, SelectItem, SelectTrigger } from "@/components/ui/select";

const harness = vi.hoisted(() => {
  const states: unknown[] = [];
  let cursor = 0;
  return {
    states, effects: [] as (() => void)[], saved: "vite", write: vi.fn(),
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
vi.mock("../utils/project-framework", () => ({ readProjectFramework: () => harness.saved, writeProjectFramework: harness.write }));
vi.mock("motion/react", () => ({ useReducedMotion: () => true }));
vi.mock("@/features/conversations/hooks/use-agent-model", () => ({ useAgentModel: () => [{ modelId: "model" }, vi.fn()] }));
vi.mock("@/features/conversations/hooks/use-agent-tasks", () => ({ useSwarmEnabled: () => false }));
vi.mock("@/features/conversations/hooks/use-enhance-prompt", () => ({ useEnhancePrompt: () => ({ isEnhancing: false }) }));
vi.mock("@/features/conversations/components/agent-model-select", () => ({ AgentModelSelect: "div" }));
vi.mock("@/features/conversations/components/enhance-prompt-button", () => ({ EnhancePromptButton: "button" }));
vi.mock("@/features/conversations/components/plan-mode-toggle", () => ({ PlanModeToggle: "div" }));
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
  harness.saved = "vite";
  vi.clearAllMocks();
});

it("offers an accessible default Vite choice and submits the selected framework", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const render = () => { harness.resetCursor(); return PromptComposer({ onSubmit }); };
  let tree = render();
  expect(find(tree, Select).props.value).toBe("vite");
  expect(find(tree, SelectTrigger).props["aria-label"]).toBe("Framework");
  expect(find(tree, SelectItem).props.children).toBe("Vite (React)");
  (find(tree, Select).props.onValueChange as (value: string) => void)("next");
  expect(harness.write).toHaveBeenCalledWith("next");
  tree = render();
  await (find(tree, PromptInput).props.onSubmit as (message: { text: string }) => Promise<void>)({ text: "A blog" });
  expect(onSubmit).toHaveBeenCalledWith("A blog", "build", "next");
});

it("restores the saved choice after mount and disables changes while creating", () => {
  harness.saved = "next";
  const render = () => { harness.resetCursor(); return PromptComposer({ onSubmit: vi.fn(), isSubmitting: true }); };
  render();
  harness.effects[0]();
  const select = find(render(), Select);
  expect(select.props.value).toBe("next");
  expect(select.props.disabled).toBe(true);
});

it("keeps framework outside the measured tools row and compacts at the counter breakpoint", () => {
  harness.resetCursor();
  const tree = PromptComposer({ onSubmit: vi.fn() });
  const trigger = find(tree, SelectTrigger);
  expect(trigger.props["data-testid"]).toBe("prompt-composer-framework");
  expect(find(trigger, "span").props.className).toBe("@max-[640px]:sr-only");
  expect(find(find(tree, PromptInputTools), Select)).toBeUndefined();
});

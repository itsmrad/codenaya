"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  ArrowUpIcon,
  ChartColumnIcon,
  KanbanSquareIcon,
  ListTodoIcon,
  Loader2Icon,
  RocketIcon,
  UserRoundIcon,
} from "lucide-react";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { AgentModelSelect } from "@/features/conversations/components/agent-model-select";
import { EnhancePromptButton } from "@/features/conversations/components/enhance-prompt-button";
import { useAgentModel } from "@/features/conversations/hooks/use-agent-model";
import { useEnhancePrompt } from "@/features/conversations/hooks/use-enhance-prompt";
import { cn } from "@/lib/utils";

/** Starter ideas: a chip fills the composer with the prompt, it never sends. */
export const STARTER_PROMPTS = [
  {
    label: "SaaS landing page",
    icon: RocketIcon,
    prompt: "SaaS landing page with a hero, feature highlights, a pricing table and an FAQ",
  },
  {
    label: "Todo app with auth",
    icon: ListTodoIcon,
    prompt: "Todo app with auth: sign up and log in, and each user sees only their own tasks",
  },
  {
    label: "Portfolio",
    icon: UserRoundIcon,
    prompt: "Portfolio site with an about section, a projects grid and a contact form",
  },
  {
    label: "Dashboard with charts",
    icon: ChartColumnIcon,
    prompt: "Dashboard with charts: KPI cards, a revenue line chart and a sortable orders table",
  },
  {
    label: "Kanban board",
    icon: KanbanSquareIcon,
    prompt: "Kanban board with drag-and-drop cards across To do, In progress and Done columns",
  },
] as const;

const PLACEHOLDER_PREFIX = "Ask Codenaya to build ";
const PLACEHOLDER_IDEAS = [
  "a SaaS landing page…",
  "a habit tracker with streaks…",
  "a recipe finder…",
  "a portfolio for a photographer…",
  "an invoice generator…",
];

/**
 * Types the placeholder ideas out one after another. Callers pause it while
 * the box is focused or has text, and when the user prefers reduced motion.
 */
const useTypedPlaceholder = (enabled: boolean) => {
  const [text, setText] = useState(PLACEHOLDER_PREFIX + PLACEHOLDER_IDEAS[0]);

  useEffect(() => {
    if (!enabled) return;
    let idea = 0;
    let length = 0;
    let pause = 0;
    const id = window.setInterval(() => {
      const target = PLACEHOLDER_IDEAS[idea];
      if (length < target.length) {
        length += 1;
      } else if (pause < 25) {
        pause += 1;
      } else {
        idea = (idea + 1) % PLACEHOLDER_IDEAS.length;
        length = 0;
        pause = 0;
      }
      setText(PLACEHOLDER_PREFIX + PLACEHOLDER_IDEAS[idea].slice(0, length));
    }, 60);
    return () => window.clearInterval(id);
  }, [enabled]);

  return text;
};

interface PromptComposerProps {
  /** Resolves to true when the prompt was accepted; the box is then cleared. */
  onSubmit: (prompt: string) => Promise<boolean>;
  isSubmitting?: boolean;
  /** Show the starter chips under the box. */
  showStarters?: boolean;
  /** Show the agent model chip (shares the chat's saved choice). */
  showModelSelect?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The "describe what to build" box: a large prompt input with the chat
 * composer's look, an optional model chip and starter chips. Used by the
 * dashboard hero and the new-project dialog.
 */
export const PromptComposer = ({
  onSubmit,
  isSubmitting = false,
  showStarters = false,
  showModelSelect = true,
  autoFocus,
  className,
}: PromptComposerProps) => {
  const [input, setInput] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [agentModel, setAgentModel] = useAgentModel();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const enhancer = useEnhancePrompt(input, setInput);
  const isBusy = isSubmitting || enhancer.isEnhancing;
  const reduceMotion = useReducedMotion();
  const placeholder = useTypedPlaceholder(!reduceMotion && !input && !isFocused);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!message.text.trim() || isBusy) return;
    if (await onSubmit(message.text)) setInput("");
  };

  const handleStarter = (prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  };

  return (
    <div className={cn("w-full", className)}>
      <div className="prompt-composer chat-composer">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              aria-label="Describe what you want to build"
              placeholder={placeholder}
              className="min-h-20 px-4 pt-4 pb-1 text-[15px]/6 placeholder:text-muted-foreground/60"
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              value={input}
              disabled={isBusy}
              autoFocus={autoFocus}
            />
          </PromptInputBody>
          <PromptInputFooter className="h-12 px-2.5 py-0">
            <PromptInputTools>
              <EnhancePromptButton
                enhancer={enhancer}
                value={input}
                disabled={isSubmitting}
              />
              {showModelSelect && (
                <AgentModelSelect
                  value={agentModel}
                  onValueChange={setAgentModel}
                  disabled={isSubmitting}
                />
              )}
            </PromptInputTools>
            <PromptInputSubmit
              disabled={!input.trim() || isBusy}
              aria-label="Create project"
              className="size-8 rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
            >
              {isSubmitting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <ArrowUpIcon className="size-4" />
              )}
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>

      {showStarters && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {STARTER_PROMPTS.map(({ label, icon: Icon, prompt }) => (
            <Suggestion
              key={label}
              suggestion={prompt}
              onClick={handleStarter}
              disabled={isSubmitting}
              className="h-8 gap-1.5 rounded-full border-border/60 bg-card/60 px-3 text-xs font-normal text-muted-foreground backdrop-blur-sm transition-colors hover:border-brand/40 hover:text-foreground"
            >
              <Icon className="size-3.5" />
              {label}
            </Suggestion>
          ))}
        </div>
      )}
    </div>
  );
};

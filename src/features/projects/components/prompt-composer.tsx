"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import {
  ArrowUpIcon,
  Loader2Icon,
  XIcon,
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
import { AgentModelSelect } from "@/features/conversations/components/agent-model-select";
import { EnhancePromptButton } from "@/features/conversations/components/enhance-prompt-button";
import { useAgentModel } from "@/features/conversations/hooks/use-agent-model";
import { useEnhancePrompt } from "@/features/conversations/hooks/use-enhance-prompt";
import { GridCross } from "@/components/landing/section-header";
import { MENU_CONTENT, MenuHeader } from "@/components/menu-chrome";
import { cn } from "@/lib/utils";

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

/** The agent model chip; its own component so signed-out composers skip its queries. */
const ComposerModelSelect = ({ disabled }: { disabled: boolean }) => {
  const [agentModel, setAgentModel] = useAgentModel();
  return (
    // Shrinks before Clear and Build do; the name truncates, the tooltip keeps it readable.
    <div className={cn(CELL, "min-w-0 shrink border-r")}>
      <AgentModelSelect
        value={agentModel}
        onValueChange={setAgentModel}
        disabled={disabled}
        contentClassName={MODEL_MENU}
        withIcons
        // Pinned to the list's top and bottom while the models scroll between them.
        header={<MenuHeader className="sticky top-0 z-10 bg-muted">Agent model</MenuHeader>}
        footer={
          <p className="sticky bottom-0 z-10 border-t border-border bg-popover px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Shared with the chat · switch any time
          </p>
        }
        // Fill the cell, so the whole cell hovers and clicks like Templates.
        triggerClassName="h-full data-[size=sm]:h-full max-w-56 rounded-none px-3 font-mono text-[10px] uppercase tracking-[0.12em] hover:bg-muted/50 dark:hover:bg-muted/50 aria-expanded:bg-muted/50"
      />
    </div>
  );
};

/** The model list in the menu look (menu-chrome): mono group labels, brand highlight. */
const MODEL_MENU = cn(
  MENU_CONTENT,
  "model-menu",
  "[&_[data-slot=select-label]]:font-mono [&_[data-slot=select-label]]:text-[10px] [&_[data-slot=select-label]]:uppercase [&_[data-slot=select-label]]:tracking-[0.14em] [&_[data-slot=select-item]]:py-2 [&_[data-slot=select-item]]:text-[13px] [&_[data-slot=select-item]:focus]:bg-brand/[0.07]",
);

/** A toolbar cell: full height, divided by lines, like the navbar's cells. */
const CELL = "flex h-full shrink-0 items-center border-border";
const TOOL = cn(
  CELL,
  "gap-1.5 border-r px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted/50 data-[state=open]:text-foreground",
);

interface PromptComposerProps {
  /** Resolves to true when the prompt was accepted; the box is then cleared. */
  onSubmit: (prompt: string) => Promise<boolean>;
  isSubmitting?: boolean;
  /** Show the agent model chip (shares the chat's saved choice). */
  showModelSelect?: boolean;
  /** Show the Enhance prompt button (needs a signed-in user). */
  showEnhance?: boolean;
  /** Extra toolbar items, e.g. the landing page's signed-out model picker. */
  tools?: ReactNode;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The "describe what to build" box, as a window on the page grid: a mono label
 * strip, the prompt, and a toolbar of cells (Enhance, the model; then a
 * character count, Clear and Build). Used by the dashboard hero, the new-project dialog and the
 * landing page.
 */
export const PromptComposer = ({
  onSubmit,
  isSubmitting = false,
  showModelSelect = true,
  showEnhance = true,
  tools,
  autoFocus,
  className,
}: PromptComposerProps) => {
  const [input, setInput] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const enhancer = useEnhancePrompt(input, setInput);
  const isBusy = isSubmitting || enhancer.isEnhancing;
  const reduceMotion = useReducedMotion();
  const placeholder = useTypedPlaceholder(!reduceMotion && !input && !isFocused);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!message.text.trim() || isBusy) return;
    if (await onSubmit(message.text)) setInput("");
  };

  const fill = (prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  };

  return (
    // A window on the page grid: `+` marks on its corners, a mono label strip,
    // the prompt, and a toolbar of cells ending in the Build cell.
    <div className={cn("group/composer relative isolate w-full text-left", className)}>
      <GridCross className="-top-[5px] -left-[5px]" />
      <GridCross className="-top-[5px] -right-[5px]" />
      <GridCross className="-bottom-[5px] -left-[5px]" />
      <GridCross className="-right-[5px] -bottom-[5px]" />

      {/* `composer-orbit` (globals.css): an orange light circles the box while it has focus. */}
      <div className="composer-window composer-orbit rounded-md border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_16px_48px_-28px_rgb(0_0_0/0.3)] transition-[border-color] duration-300 focus-within:border-brand/30">
        {/* Label strip */}
        <div className="flex h-9 items-center justify-between gap-3 border-b border-border px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="h-3 w-0.5 bg-brand" />
            <span>[ {isSubmitting ? "Creating project…" : "New project"} ]</span>
          </span>
          <span className="flex items-center gap-2 max-sm:hidden">
            <span className={cn("size-1.5 rounded-full bg-brand", isBusy ? "animate-ping" : "animate-pulse")} />
            ↵ Build · ⇧↵ New line
          </span>
        </div>

        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              aria-label="Describe what you want to build"
              placeholder={placeholder}
              className="min-h-24 px-5 pt-4 pb-3 text-[15px]/7 placeholder:text-muted-foreground/55"
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              value={input}
              disabled={isBusy}
              autoFocus={autoFocus}
            />
          </PromptInputBody>

          {/* Toolbar of cells; p-0! beats the addon's own padding so every cell centres. */}
          <PromptInputFooter className="h-11 items-stretch gap-0 border-t border-border p-0!">
            <PromptInputTools className="min-w-0 items-stretch gap-0">
              {showEnhance && (
                <EnhancePromptButton
                  enhancer={enhancer}
                  value={input}
                  disabled={isSubmitting}
                  showLabel
                  className={cn(TOOL, "h-full rounded-none [&_svg]:size-3.5")}
                />
              )}
              {tools}
              {showModelSelect && <ComposerModelSelect disabled={isSubmitting} />}
            </PromptInputTools>

            <div className="flex items-stretch">
              {input && (
                <span
                  className={cn(
                    CELL,
                    "border-l px-3 font-mono text-[10px] tabular-nums tracking-[0.12em] text-muted-foreground max-md:hidden",
                  )}
                >
                  {input.length.toLocaleString("en-US")} CHARS
                </span>
              )}
              {/* Always in the bar, like Enhance; disabled while there's nothing to clear. */}
              <button
                type="button"
                aria-label="Clear prompt"
                onClick={() => fill("")}
                disabled={isBusy || !input}
                className={cn(TOOL, "border-r-0 border-l")}
              >
                <XIcon className="size-3.5" />
                <span className="max-sm:sr-only">Clear</span>
              </button>
              <PromptInputSubmit
                disabled={!input.trim() || isBusy}
                aria-label="Create project"
                className="sheen h-full w-auto gap-2 rounded-none rounded-br-[5px] border-l border-border bg-brand px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-foreground hover:bg-brand/90 disabled:bg-muted/60 disabled:text-muted-foreground disabled:opacity-100 has-[>svg]:px-4"
              >
                <span className="max-sm:hidden">{isSubmitting ? "Building" : "Build"}</span>
                {isSubmitting ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUpIcon className="size-3.5" />
                )}
              </PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
};

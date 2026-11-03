import { ArrowUpRightIcon, SparklesIcon } from "lucide-react";

import { Suggestion } from "@/components/ai-elements/suggestion";

import type { ChatStarters } from "../chat-starters";

interface ChatEmptyStateProps {
  starters: ChatStarters;
  onSelect: (prompt: string) => void;
}

/** Start of a new conversation: a short intro and prompts to send in one click. */
export const ChatEmptyState = ({ starters, onSelect }: ChatEmptyStateProps) => (
  <div className="flex flex-1 flex-col justify-center overflow-y-auto px-4 py-6">
    <div className="grid size-9 place-items-center rounded-xl bg-muted">
      <SparklesIcon className="size-4 text-brand" />
    </div>
    <h2 className="mt-3 text-base font-medium">{starters.title}</h2>
    <p className="text-sm text-muted-foreground">
      Codenaya edits your project files directly.
    </p>
    <div className="mt-5 grid gap-2">
      {starters.suggestions.map(({ icon: Icon, prompt }, index) => (
        <Suggestion
          key={prompt}
          suggestion={prompt}
          onClick={onSelect}
          variant="ghost"
          style={{ animationDelay: `${index * 90}ms` }}
          className="group h-auto animate-fade-up justify-start gap-2.5 whitespace-normal rounded-lg border border-border px-3 py-2.5 text-left text-[13px] font-normal text-foreground/80 transition-colors duration-150 hover:bg-accent/40 hover:text-foreground motion-reduce:animate-none"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{prompt}</span>
          <ArrowUpRightIcon className="size-3.5 shrink-0 -translate-x-0.5 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:translate-x-0 [@media(hover:none)]:opacity-100" />
        </Suggestion>
      ))}
    </div>
  </div>
);

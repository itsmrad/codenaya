import {
  ArrowUpRightIcon,
  BugIcon,
  DatabaseIcon,
  LayoutTemplateIcon,
  PaletteIcon,
  SparklesIcon,
} from "lucide-react";

import { Suggestion } from "@/components/ai-elements/suggestion";

const SUGGESTIONS = [
  { icon: LayoutTemplateIcon, prompt: "Add a landing page with a hero and pricing section" },
  { icon: PaletteIcon, prompt: "Restyle the app with a clean, minimal dark theme" },
  { icon: BugIcon, prompt: "Find and fix bugs in the current code" },
  { icon: DatabaseIcon, prompt: "Add a todo list that saves to localStorage" },
];

interface ChatEmptyStateProps {
  onSelect: (prompt: string) => void;
}

/** Start of a new conversation: a short intro and prompts to send in one click. */
export const ChatEmptyState = ({ onSelect }: ChatEmptyStateProps) => (
  <div className="flex flex-1 flex-col justify-center overflow-y-auto px-4 py-6">
    <div className="grid size-9 place-items-center rounded-xl bg-muted">
      <SparklesIcon className="size-4 text-brand" />
    </div>
    <h2 className="mt-3 text-base font-medium">What do you want to build?</h2>
    <p className="text-sm text-muted-foreground">
      Codenaya edits your project files directly.
    </p>
    <div className="mt-5 grid gap-2">
      {SUGGESTIONS.map(({ icon: Icon, prompt }) => (
        <Suggestion
          key={prompt}
          suggestion={prompt}
          onClick={onSelect}
          variant="ghost"
          className="group h-auto justify-start gap-2.5 whitespace-normal rounded-lg border border-border px-3 py-2.5 text-left text-[13px] font-normal text-foreground/80 transition-colors duration-100 hover:bg-accent/60 hover:text-foreground"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{prompt}</span>
          <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
        </Suggestion>
      ))}
    </div>
  </div>
);

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavRow } from "../nav-row";
import type { ModelId } from "../types";

const MODELS: { id: ModelId; n: string; name: string; desc: string; tag: string }[] = [
  {
    id: "claude-sonnet-4",
    n: "01",
    name: "Claude Sonnet 4",
    desc: "Best reasoning and code quality",
    tag: "recommended",
  },
  {
    id: "gemini-2.0-flash",
    n: "02",
    name: "Gemini 2.0 Flash",
    desc: "Fast, capable, free to use",
    tag: "free",
  },
];

export function ModelStep({
  model,
  onSelect,
  onNext,
  onBack,
}: {
  model: ModelId;
  onSelect: (m: ModelId) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-4xl font-bold text-foreground">
          Choose your AI model
        </h1>
        <p className="max-w-[420px] text-[15px] text-muted-foreground">
          Powers code suggestions, Cmd+K edits, and the chat assistant. You
          can change this anytime.
        </p>

        <div role="radiogroup" className="flex max-w-[544px] flex-col">
          {MODELS.map((m) => {
            const selected = model === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(m.id)}
                className="flex items-center gap-4 border-b border-border py-4 text-left"
              >
                <span
                  className={cn(
                    "w-6 shrink-0 font-mono text-xl",
                    selected ? "text-brand" : "text-muted-foreground/45"
                  )}
                >
                  {m.n}
                </span>
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-base font-semibold text-foreground">
                    {m.name}
                  </p>
                  <p className="text-[13px] text-muted-foreground">{m.desc}</p>
                </div>
                <span
                  className={cn(
                    "font-mono text-xs",
                    selected ? "text-brand" : "text-muted-foreground"
                  )}
                >
                  {m.tag}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <NavRow onBack={onBack}>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={onNext}
        >
          Continue
        </Button>
      </NavRow>
    </div>
  );
}

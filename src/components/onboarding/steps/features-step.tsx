import { Button } from "@/components/ui/button";
import { NavRow } from "../nav-row";

const FEATURES = [
  {
    n: "01",
    title: "Real-time collaboration",
    desc: "Edit code together, live, powered by Convex.",
  },
  {
    n: "02",
    title: "AI suggestions & Cmd+K",
    desc: "Ghost-text completions plus natural-language edits.",
  },
  {
    n: "03",
    title: "Instant in-browser preview",
    desc: "Run full-stack apps with WebContainer, no server.",
  },
];

export function FeaturesStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-4xl font-bold text-foreground">What you get</h1>
        <div className="flex max-w-[544px] flex-col">
          {FEATURES.map((f) => (
            <div
              key={f.n}
              className="flex items-center gap-4 border-b border-border py-4"
            >
              <span className="w-6 shrink-0 font-mono text-xl text-muted-foreground/45">
                {f.n}
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-base font-semibold text-foreground">
                  {f.title}
                </p>
                <p className="text-[13px] text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          ))}
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

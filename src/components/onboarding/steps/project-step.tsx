import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavRow } from "../nav-row";
import type { ModelId } from "../types";

const TEMPLATES = ["Blank", "Next.js", "React + Vite"];

interface ProjectStepProps {
  projectName: string;
  onProjectNameChange: (v: string) => void;
  template: number;
  onTemplateChange: (i: number) => void;
  onBack: () => void;
  onCreate: () => Promise<void>;
  creating: boolean;
  created: boolean;
  model: ModelId;
  githubConnected: boolean;
  onGoToDashboard: () => void;
}

export function ProjectStep({
  projectName,
  onProjectNameChange,
  template,
  onTemplateChange,
  onBack,
  onCreate,
  creating,
  created,
  model,
  githubConnected,
  onGoToDashboard,
}: ProjectStepProps) {
  const [touched, setTouched] = useState(false);
  const showError = touched && projectName.trim().length === 0;

  if (created) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col gap-7">
          <h1 className="text-[40px] font-bold leading-[1.12] text-foreground">
            Workspace ready
          </h1>
          <p className="max-w-[420px] text-[15px] leading-relaxed text-muted-foreground">
            &ldquo;{projectName}&rdquo; is set up with{" "}
            {model === "claude-sonnet-4" ? "Claude Sonnet 4" : "Gemini 2.0 Flash"}
            {githubConnected ? " and GitHub linked" : ""}. Jump in and start
            building.
          </p>
        </div>
        <NavRow>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={onGoToDashboard}
          >
            Go to Dashboard
          </Button>
        </NavRow>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-4xl font-bold text-foreground">
          Create your project
        </h1>

        <div className="flex max-w-[460px] flex-col gap-2">
          <label htmlFor="project-name" className="text-xs font-medium text-muted-foreground">
            Project name
          </label>
          <input
            id="project-name"
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={showError}
            className={cn(
              "border-b border-border bg-transparent pb-2.5 font-mono text-[15px] text-foreground outline-none focus:border-brand",
              showError && "border-destructive"
            )}
          />
          <p className="min-h-[15px] text-xs text-destructive">
            {showError ? "Give your project a name." : ""}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-muted-foreground">Start from</p>
          <div role="tablist" className="flex gap-7">
            {TEMPLATES.map((label, i) => (
              <button
                key={label}
                role="tab"
                aria-selected={template === i}
                type="button"
                onClick={() => onTemplateChange(i)}
                className="flex flex-col items-start gap-2"
              >
                <span
                  className={cn(
                    "font-mono text-sm",
                    template === i
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground/75"
                  )}
                >
                  {label}
                </span>
                <div
                  className={cn(
                    "h-0.5 w-full",
                    template === i ? "bg-brand" : "bg-transparent"
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <NavRow onBack={onBack}>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={creating || projectName.trim().length === 0}
          onClick={() => {
            if (projectName.trim().length === 0) {
              setTouched(true);
              return;
            }
            void onCreate();
          }}
        >
          {creating ? "Creating…" : "Create workspace"}
        </Button>
      </NavRow>
    </div>
  );
}

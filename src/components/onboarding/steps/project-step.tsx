import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, FolderCode, Loader2, Sparkles } from "lucide-react";
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
  onSkip: () => Promise<void>;
  creating: boolean;
  skipping: boolean;
  created: boolean;
  model: ModelId;
  githubConnected: boolean;
  onGoToDashboard: (explicitId?: string | null) => void;
  prompt?: string;
  projectId?: string | null;
}

export function ProjectStep({
  projectName,
  onProjectNameChange,
  template,
  onTemplateChange,
  onBack,
  onCreate,
  onSkip,
  creating,
  skipping,
  created,
  model,
  githubConnected,
  onGoToDashboard,
  prompt,
  projectId,
}: ProjectStepProps) {
  const [touched, setTouched] = useState(false);
  const [countdown, setCountdown] = useState(2);
  const showError = touched && projectName.trim().length === 0;

  const onGoToDashboardRef = useRef(onGoToDashboard);
  useEffect(() => {
    onGoToDashboardRef.current = onGoToDashboard;
  }, [onGoToDashboard]);

  // Auto-redirect to the IDE page after workspace is created
  useEffect(() => {
    if (!created) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onGoToDashboardRef.current(projectId);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [created, projectId]);

  if (created) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col gap-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium w-fit">
            <CheckCircle2 className="size-3.5" />
            Workspace created!
          </div>

          <div>
            <h1 className="text-3xl sm:text-[40px] font-bold leading-[1.12] text-foreground">
              Opening your workspace…
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground flex items-center gap-2">
              <span>Redirecting to the IDE in {countdown}s…</span>
              <Loader2 className="size-3.5 animate-spin text-brand" />
            </p>
          </div>

          {/* Final Summary Card */}
          <div className="max-w-[500px] rounded-xl bg-card border border-border/80 p-5 shadow-lg space-y-4">
            <div className="space-y-1">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
                Project Name
              </span>
              <div className="text-lg font-semibold text-foreground flex items-center gap-2">
                <FolderCode className="size-4 text-brand" />
                <span>{projectName}</span>
              </div>
            </div>

            {prompt && (
              <div className="space-y-1.5 pt-3 border-t border-border/50">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
                  Your Prompt
                </span>
                <div className="rounded-lg bg-muted/40 p-3.5 border border-border/40">
                  <p className="text-sm text-foreground/90 font-medium italic leading-relaxed">
                    &ldquo;{prompt}&rdquo;
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border/50 text-xs">
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase font-mono">
                  AI Model
                </span>
                <span className="font-medium text-foreground">
                  {model === "claude-sonnet-4" ? "Claude Sonnet 4" : "Gemini 2.0 Flash"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase font-mono">
                  Repository
                </span>
                <span className="font-medium text-foreground">
                  {githubConnected ? "GitHub Connected" : "Local Workspace"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <NavRow>
          <Button
            size="lg"
            className="bg-brand text-brand-foreground hover:bg-brand/90 font-medium shadow-lg shadow-brand/20 px-8 cursor-pointer"
            onClick={() => onGoToDashboard(projectId)}
          >
            Open IDE Workspace
            <ArrowRight className="size-4 ml-2" />
          </Button>
        </NavRow>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-foreground">
            Ready to start building?
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Configure your initial project settings or skip for now to visit your dashboard.
          </p>
        </div>

        {prompt && (
          <div className="max-w-[460px] p-3 rounded-lg bg-muted/30 border border-border/50 space-y-1">
            <div className="flex items-center gap-1.5 text-brand text-xs font-medium">
              <Sparkles className="size-3.5" />
              <span>Project configured from prompt</span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 italic">
              &ldquo;{prompt}&rdquo;
            </p>
          </div>
        )}

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
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            type="button"
            disabled={creating || skipping}
            onClick={() => void onSkip()}
            className="text-muted-foreground hover:text-foreground cursor-pointer text-sm font-medium"
          >
            {skipping ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Skipping…
              </span>
            ) : (
              "Skip for now"
            )}
          </Button>

          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90 font-medium px-6 cursor-pointer shadow-md shadow-brand/10"
            disabled={creating || skipping || projectName.trim().length === 0}
            onClick={() => {
              if (projectName.trim().length === 0) {
                setTouched(true);
                return;
              }
              void onCreate();
            }}
          >
            {creating ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Creating workspace…
              </span>
            ) : (
              "Create Project"
            )}
          </Button>
        </div>
      </NavRow>
    </div>
  );
}


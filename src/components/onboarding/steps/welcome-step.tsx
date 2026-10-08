import { Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavRow } from "../nav-row";

interface WelcomeStepProps {
  onNext: () => void;
  prompt?: string;
  projectName?: string;
}

export function WelcomeStep({ onNext, prompt, projectName }: WelcomeStepProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-6">
        {prompt ? (
          <>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand text-xs font-medium w-fit">
              <Sparkles className="size-3.5 animate-pulse" />
              Preparing your project
            </div>

            <div className="space-y-2">
              <h1 className="text-[34px] sm:text-[40px] font-bold leading-[1.12] text-foreground">
                Welcome to Codenaya
              </h1>
              <p className="text-sm text-muted-foreground max-w-[460px] leading-relaxed">
                Your workspace is being configured for{" "}
                <span className="font-semibold text-foreground">
                  {projectName || "your new project"}
                </span>
                .
              </p>
            </div>

            {/* Prompt Display Card */}
            <div className="max-w-[480px] rounded-xl bg-card border border-border/80 p-4 shadow-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
                  Original Prompt
                </span>
                <span className="text-[10px] text-emerald-400 font-mono">attached</span>
              </div>
              <p className="text-sm text-foreground/90 font-medium italic leading-relaxed">
                &ldquo;{prompt}&rdquo;
              </p>
            </div>

            <p className="max-w-[440px] text-xs text-muted-foreground/80 leading-relaxed">
              We&apos;ll guide you through a few quick setup steps to connect your
              account, choose your preferred AI model, and launch your workspace.
            </p>
          </>
        ) : (
          <>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted/60 border border-border/40 text-muted-foreground text-xs font-medium w-fit">
              <Terminal className="size-3.5" />
              Workspace Setup
            </div>

            <h1 className="text-[40px] font-bold leading-[1.12] text-foreground">
              Welcome to Codenaya
            </h1>
            <p className="max-w-[420px] text-[15px] leading-relaxed text-muted-foreground">
              Your AI-powered, browser-based IDE. Complete these quick configuration
              steps to tailor your environment, then jump straight into building.
            </p>
          </>
        )}
      </div>

      <NavRow>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90 font-medium px-6"
          onClick={onNext}
        >
          {prompt ? "Continue Setup →" : "Get Started"}
        </Button>
      </NavRow>
    </div>
  );
}

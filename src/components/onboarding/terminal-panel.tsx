"use client";

import { cn } from "@/lib/utils";
import type { AuthMethod, ModelId, StepKey } from "./types";

type LineState = "done" | "current" | "pending";

interface TerminalPanelProps {
  stepKey: StepKey;
  authMethod: AuthMethod;
  githubConnected: boolean;
  model: ModelId;
  projectName: string;
  created: boolean;
}

function LogLine({ text, state }: { text: string; state: LineState }) {
  return (
    <div className="flex items-center gap-3">
      <div
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-[1px]",
          state === "done" && "bg-emerald-400",
          state === "current" && "bg-brand",
          state === "pending" && "bg-muted-foreground/40"
        )}
      />
      <span
        className={cn(
          "font-mono text-sm",
          state === "done" && "text-foreground",
          state === "current" && "font-medium text-brand",
          state === "pending" && "text-muted-foreground/75"
        )}
      >
        {text}
      </span>
    </div>
  );
}

export function TerminalPanel({
  stepKey,
  authMethod,
  githubConnected,
  model,
  projectName,
  created,
}: TerminalPanelProps) {
  const authDone = stepKey !== "auth" && authMethod !== null;
  const modelDone = stepKey !== "model" && ALL_STEPS_AFTER("model", stepKey);
  const projectDone = created;

  const lines: { text: string; state: LineState }[] = [
    { text: "workspace ready", state: "done" },
    {
      text: authMethod ? "auth: takeshi" : "auth: —",
      state: stepKey === "auth" ? "current" : authDone ? "done" : "pending",
    },
    { text: "convex: connected", state: "done" },
    {
      text: githubConnected ? "github: connected" : "github: —",
      state: stepKey === "github" ? "current" : githubConnected ? "done" : "pending",
    },
    {
      text: modelDone ? `ai model: ${model}` : "ai model: —",
      state: stepKey === "model" ? "current" : modelDone ? "done" : "pending",
    },
    {
      text: projectDone ? `project: ${projectName}` : "project: —",
      state: stepKey === "project" ? (projectDone ? "done" : "current") : "pending",
    },
  ];

  return (
    <div className="hidden w-[560px] shrink-0 flex-col gap-4 bg-background px-14 py-16 md:flex">
      <p className="mb-1 font-mono text-[15px] font-medium text-brand">
        $ codenaya init
      </p>

      {lines.map((line) => (
        <LogLine key={line.text.split(":")[0]} text={line.text} state={line.state} />
      ))}

      {!created && (
        <div className="flex items-center gap-3" aria-hidden>
          <div className="size-1.5" />
          <div className="h-[18px] w-[9px] animate-pulse bg-brand" />
        </div>
      )}

      {/* Fills the panel's dead space with real (if illustrative) context
          instead of leaving a big empty gap. */}
      <div className="mt-7 flex flex-col gap-1.5 border-t border-border pt-5">
        <SysInfoLine label="runtime" value="node 22.x" />
        <SysInfoLine label="plan" value="free tier" />
      </div>

      <p className="mt-auto max-w-[420px] font-mono text-xs text-muted-foreground">
        This log fills in as you complete setup.
      </p>
    </div>
  );
}

function SysInfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex max-w-[300px] justify-between font-mono text-xs text-muted-foreground">
      <b className="font-medium">{label}</b>
      <span>{value}</span>
    </div>
  );
}

// helper kept local since it's only meaningful within this file's step ordering
function ALL_STEPS_AFTER(target: StepKey, current: StepKey) {
  const order: StepKey[] = ["welcome", "features", "auth", "github", "model", "project"];
  return order.indexOf(current) > order.indexOf(target);
}

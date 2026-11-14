"use client";

import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { WorkspaceMode } from "@/features/projects/utils/workspace-mode";

import { useSetWorkspaceMode, useWorkspaceMode } from "../hooks/use-workspace-mode";

// Each sketch lists its panes left to right as flex weights.
const MODES: { value: WorkspaceMode; label: string; description: string; panes: number[] }[] = [
  {
    value: "chat",
    label: "Chat-first",
    description: "Chat and preview only, best for building without code.",
    panes: [2, 3],
  },
  {
    value: "ide",
    label: "IDE",
    description: "Chat, code editor, files and preview.",
    panes: [2, 1, 3],
  },
];

const LayoutSketch = ({ panes }: { panes: number[] }) => (
  <div aria-hidden="true" className="flex h-16 gap-1 rounded-md border border-border/60 bg-muted/40 p-1">
    {panes.map((grow, index) => (
      <div key={index} className="rounded-sm bg-background ring-1 ring-border/60" style={{ flexGrow: grow }} />
    ))}
  </div>
);

export const WorkspaceSettings = () => {
  const { mode, loaded, failed } = useWorkspaceMode();
  const setWorkspaceMode = useSetWorkspaceMode();

  const onValueChange = (value: string) => {
    setWorkspaceMode({ workspaceMode: value as WorkspaceMode }).catch(() =>
      toast.error("Could not save the workspace mode"),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace mode</CardTitle>
        <CardDescription>
          Pick the layout projects open in. In Chat-first you can still open the code for one visit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed && (
          <p role="status" className="text-sm text-muted-foreground">
            The workspace mode can&apos;t be loaded right now. Try again later.
          </p>
        )}
        <RadioGroup
          aria-label="Workspace mode"
          value={mode}
          disabled={!loaded}
          onValueChange={onValueChange}
          className="grid-cols-1 sm:grid-cols-2"
        >
          {MODES.map(({ value, label, description, panes }) => (
            <Label
              key={value}
              htmlFor={`workspace-mode-${value}`}
              className={cn(
                "flex cursor-pointer flex-col items-stretch gap-3 rounded-lg border p-4 font-normal transition-colors",
                mode === value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
              )}
            >
              <LayoutSketch panes={panes} />
              <div className="flex items-start gap-3">
                <RadioGroupItem id={`workspace-mode-${value}`} value={value} className="mt-0.5" />
                <div className="space-y-1">
                  <div className="text-sm font-medium">{label}</div>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
              </div>
            </Label>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  );
};

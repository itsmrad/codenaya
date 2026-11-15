"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useProjectIntegrations } from "@/features/integrations/components/project-integrations-context";
import type { Doc } from "../../../../convex/_generated/dataModel";

const subscribe = () => () => {};

export function ImportNotice({ project, onAddVariables }: {
  project: Doc<"projects">;
  onAddVariables: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { openIntegrations } = useProjectIntegrations();
  const storageKey = `import-notice:${project._id}`;
  const previouslyDismissed = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(storageKey) === "dismissed"; }
    catch { return false; }
  }, () => true);
  const names = project.importInfo?.envVarNames ?? [];
  if (dismissed || previouslyDismissed || project.importStatus !== "completed" || !names.length) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(storageKey, "dismissed"); }
    catch { /* Still dismiss for this session when browser storage is unavailable. */ }
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="min-w-0 flex-1 basis-64">
        {project.importInfo?.source ? "Detected a project from another builder. " : "Project imported. "}
        This app expects {names.length} environment {names.length === 1 ? "variable" : "variables"}.
      </p>
      <Button size="sm" onClick={() => { onAddVariables(); dismiss(); }}>Add variables</Button>
      {names.some((name) => name.includes("SUPABASE")) && (
        <Button size="sm" variant="outline" onClick={() => openIntegrations("supabase")}>Supabase integration</Button>
      )}
      <Link href="/docs#moving-projects" className="underline underline-offset-4">Import guide</Link>
      <Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
    </div>
  );
}

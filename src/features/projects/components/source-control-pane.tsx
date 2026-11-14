"use client";

import { useMemo, useState } from "react";
import { useQueries } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { GitBranchIcon, GitCompareArrowsIcon, HistoryIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RestoreCheckpointDialog } from "@/features/conversations/components/checkpoint-dialogs";
import { LineDelta, RunDiffDialog } from "@/features/conversations/components/run-diff-dialog";
import { type Checkpoint, useRunChanges } from "@/features/conversations/hooks/use-checkpoints";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { GITHUB_SYNC_BRANCH } from "../constants";
import { comparisonBaseline } from "../utils/source-control";

/** Mounted only while its explorer pane is visible: comparisons read file content. */
export function SourceControlPane({ project, projectId, disabled }: {
  project: Doc<"projects"> | null | undefined;
  projectId: Id<"projects">;
  disabled: boolean;
}) {
  const queries = useMemo(() => ({
    history: { query: api.checkpoints.list, args: { projectId } },
    unpushed: { query: api.githubSync.unpushedRuns, args: { projectId } },
  }), [projectId]);
  const { history, unpushed } = useQueries(queries);
  const checkpoints: Checkpoint[] = history instanceof Error ? [] : history ?? [];
  const [selected, setSelected] = useState<string>();
  const baseline = comparisonBaseline(checkpoints, selected);
  const changes = useRunChanges(baseline?._id, "project");
  const [diff, setDiff] = useState<{ checkpointId: Id<"checkpoints">; path?: string; scope?: "project" }>();
  const [restoring, setRestoring] = useState<Checkpoint | null>(null);
  const sync = project?.githubSync;
  const note = (text: string) => <p role="status" className="px-3 py-5 text-xs leading-relaxed text-muted-foreground">{text}</p>;

  return (
    <section aria-label="Source control" className="min-h-0 flex-1 overflow-y-auto text-xs">
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center gap-2 font-medium"><GitBranchIcon aria-hidden="true" className="size-4 text-brand-text" />GitHub sync</div>
        {sync ? <p className="break-all font-mono">{sync.repo} · {sync.syncBranchSha ? GITHUB_SYNC_BRANCH : sync.branch}</p> : <p className="text-muted-foreground">No linked repository. Connect GitHub through Export.</p>}
        <details>
          <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Sync details</summary>
        {project === undefined ? note("Loading repository…") : sync ? (
          <>
            <p className="break-all font-mono">{sync.repo}</p>
            <p className="break-all text-muted-foreground">Branch <span className="font-mono text-foreground">{sync.branch}</span></p>
            {sync.syncBranchSha && <p className="text-brand-text">Push branch: {GITHUB_SYNC_BRANCH} · linked branch has moved</p>}
            <p className="text-muted-foreground">Last sync <span className="font-mono">{(sync.syncBranchSha ?? sync.lastSyncedSha).slice(0, 7)}</span> · {formatDistanceToNow(sync.syncBranchAt ?? sync.lastSyncedAt, { addSuffix: true })}</p>
            <p role="status" className="text-muted-foreground">{unpushed instanceof Error ? "Couldn't load pending runs." : unpushed === undefined ? "Loading pending runs…" : unpushed ? `${unpushed.count}${unpushed.more ? "+" : ""} finished runs since sync${unpushed.running ? " · agent running" : ""}` : "No sync information."}</p>
          </>
        ) : <p className="text-muted-foreground">No linked repository. Connect GitHub through Export.</p>}
        <p className="mt-2 leading-relaxed text-muted-foreground">Push and pull in Export. Finished agent runs become GitHub commits on push; older runs may share one summary commit. This history shows checkpoints, without per-run commit SHAs or local Git branches.</p>
        </details>
      </div>

      <div className="border-b p-3">
        <h3 className="mb-2 flex items-center gap-2 font-medium"><GitCompareArrowsIcon aria-hidden="true" className="size-3.5" />Changes <span className="ml-auto rounded bg-muted px-1.5 font-mono tabular-nums">{Array.isArray(changes) ? changes.length : "—"}</span></h3>
        {baseline && <>
          <label id="comparison-label" className="mb-1 block text-muted-foreground">Current files compared with</label>
          <Select value={baseline._id} onValueChange={setSelected}>
            <SelectTrigger aria-labelledby="comparison-label" className="h-auto min-h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {checkpoints.map((checkpoint) => <SelectItem key={checkpoint._id} value={checkpoint._id}>{checkpoint.messageId ? "Before run" : "Snapshot"} · {checkpoint.label || "Untitled"} · {new Date(checkpoint._creationTime).toLocaleString()}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">A added · M modified · D deleted. Renames appear as deletion + addition.</p>
        </>}
      </div>
      {history instanceof Error ? note("Couldn't load history. Switch to Files and reopen Source control to retry.")
        : history === undefined ? note("Loading checkpoints…")
        : !baseline ? note("No checkpoints yet. A snapshot is saved before an agent run, restore, delete or GitHub pull.")
        : changes instanceof Error ? note("Couldn't load changes. Switch to Files and reopen Source control to retry.")
        : changes === undefined ? note("Comparing files…")
        : changes === null ? note("Comparison too large: at most 200 file/folder entries and 4 MiB read budget per side. No partial results are shown. Open individual run diffs from history.")
        : changes.length === 0 ? note("No changes since this checkpoint.")
        : <ul aria-label="Project changed files" className="py-1">
          {changes.map((change) => <li key={change.path}>
            <button type="button" title={change.path} onClick={() => setDiff({ checkpointId: baseline._id, path: change.path, scope: "project" })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span aria-label={change.status} className={change.status === "deleted" ? "font-mono text-destructive" : "font-mono text-brand-text"}>{change.status[0].toUpperCase()}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
              <span className="shrink-0 text-[10px]"><LineDelta change={change} /></span>
            </button>
          </li>)}
        </ul>}

      <div className="border-t p-3">
        <h3 className="mb-1 flex items-center gap-2 font-medium"><HistoryIcon aria-hidden="true" className="size-3.5" />Checkpoint history</h3>
        <p className="mb-3 leading-relaxed text-muted-foreground">Up to 20 retained snapshots of at most 2,000 entries, newest first. Run snapshots capture files before the run. Compare includes all changes through now.</p>
        <ol aria-label="Checkpoint history" className="ml-1.5 border-l border-border pl-3">
          {checkpoints.map((checkpoint) => <li key={checkpoint._id} className="relative pb-4">
            <span aria-hidden="true" className="absolute -left-4 top-1 size-1.5 rounded-full bg-brand" />
            <p className="truncate font-medium" title={checkpoint.label}>{checkpoint.label || "Untitled checkpoint"}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{checkpoint.messageId ? "Before run" : "Snapshot"} · {formatDistanceToNow(checkpoint._creationTime, { addSuffix: true })} · {checkpoint.fileCount} files</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" aria-pressed={baseline?._id === checkpoint._id} onClick={() => setSelected(checkpoint._id)}>Compare to current</Button>
              {checkpoint.messageId && <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" onClick={() => setDiff({ checkpointId: checkpoint._id })}>Run diff</Button>}
              <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" disabled={disabled} title={disabled ? "Stop the running agent first" : undefined} onClick={() => setRestoring(checkpoint)}><RotateCcwIcon aria-hidden="true" className="size-3" />Restore</Button>
            </div>
          </li>)}
        </ol>
      </div>
      {disabled && <p role="status" className="px-3 pb-3 text-muted-foreground">Restore and discard are unavailable while an agent is running.</p>}
      {diff && <RunDiffDialog key={`${diff.checkpointId}:${diff.path ?? "run"}`} checkpointId={diff.checkpointId} initialPath={diff.path} scope={diff.scope} open onOpenChange={(open) => { if (!open) setDiff(undefined); }} revertDisabled={disabled} />}
      <RestoreCheckpointDialog checkpoint={restoring} onOpenChange={(open) => { if (!open) setRestoring(null); }} />
    </section>
  );
}

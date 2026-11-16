"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { CopyIcon, Share2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { convexErrorMessage } from "@/lib/convex-error";
import { useProject } from "@/features/projects/hooks/use-projects";

import { sharePath } from "../utils";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** Share only the running website, with owner-selected version and lifetime. */
export const SharePopover = ({ projectId, trigger }: { projectId: Id<"projects">; trigger?: React.ReactNode }) => {
  const project = useProject(projectId);
  const revokeShareLink = useMutation(api.projects.revokeShareLink);
  const [mode, setMode] = useState<"snapshot" | "latest" | null>(null);
  const [chosenMinutes, setMinutes] = useState<0 | 15 | 30 | 60 | null>(null);
  const minutes = chosenMinutes ?? project?.shareKeepLiveMinutes ?? 0;
  const selectedMode = mode ?? project?.shareMode ?? "snapshot";
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [refreshSnapshot, setRefreshSnapshot] = useState(false);
  const [saving, setSaving] = useState(false);

  const token = project?.shareToken;
  // Only set client side: the token arrives with the live project query.
  const url = token ? new URL(sharePath(token), window.location.origin).toString() : null;

  const dirty = selectedMode !== (project?.shareMode ?? "snapshot") || minutes !== (project?.shareKeepLiveMinutes ?? 0) || refreshSnapshot;
  const toggle = async (on: boolean) => {
    setEnabled(on);
    if (!token) return;
    if (on) { await save(true); return; }
    setSaving(true);
    try { await revokeShareLink({ projectId }); }
    catch (error) { setEnabled(null); toast.error(convexErrorMessage(error, "Couldn't turn off the link")); }
    finally { setSaving(false); }
  };

  const save = async (enableOnly = false) => {
    setSaving(true);
    try {
      const response = await fetch("/api/share-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enableOnly ? { projectId, enableOnly: true } : { projectId, mode: selectedMode, minutes, updateSnapshot: refreshSnapshot }),
      });
      const result = await response.json();
      if (!response.ok) { setEnabled(null); toast.error("Couldn't save the share link. Try again."); return; }
      if (!enableOnly) setRefreshSnapshot(false);
      setEnabled(null);
      if (result.status === "busy") toast.error("Preview is busy. Try again shortly.");
      else if (result.status === "error") toast.error("Couldn't start the preview. Try again.");
    } catch { setEnabled(null); toast.error("Couldn't save the share link. Try again."); }
    finally { setSaving(false); }
  };

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? <button
          type="button"
          aria-label="Share"
          title="Share"
          className="flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
        >
          <Share2Icon aria-hidden="true" className="size-3.5" />
          <span className="hidden @3xl:inline">Share</span>
        </button>}
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-1.5rem)] flex flex-col gap-4" align="end">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="block font-medium">Anyone with the link can view</span>
            <span className="block text-xs text-muted-foreground">
              The running website only, with Remix. No code, chat or secret env vars.
            </span>
          </span>
          {token && <Switch
            checked={enabled ?? (project?.shareEnabled !== false)}
            disabled={project === undefined || saving}
            onCheckedChange={toggle}
            aria-label="Anyone with the link can view"
            title={(enabled ?? (project?.shareEnabled !== false)) ? "Turn off link" : "Turn on link"}
          />}
        </label>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            What to share
            <Select value={selectedMode} disabled={saving || !project} onValueChange={value => setMode(value as "snapshot" | "latest")}>
              <SelectTrigger aria-label="What to share" className="w-full font-normal"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>
                <SelectItem value="snapshot">This version (snapshot now)</SelectItem>
                <SelectItem value="latest">Always the latest saved version</SelectItem>
              </SelectGroup></SelectContent>
            </Select>
          </label>
          {token && selectedMode === "snapshot" && <Button variant="outline" size="sm" disabled={saving} onClick={() => setRefreshSnapshot(true)}>{refreshSnapshot ? "Shared version ready to update" : "Update shared version"}</Button>}
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            How long it stays live
            <Select value={String(minutes)} disabled={saving || !project} onValueChange={value => setMinutes(Number(value) as 0 | 15 | 30 | 60)}>
              <SelectTrigger aria-label="How long it stays live" className="w-full font-normal"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>
                <SelectItem value="0">Start on visit (no time limit)</SelectItem>
                <SelectItem value="15">Keep it live for 15 min</SelectItem>
                <SelectItem value="30">Keep it live for 30 min</SelectItem>
                <SelectItem value="60">Keep it live for 1 hour</SelectItem>
              </SelectGroup></SelectContent>
            </Select>
          </label>
          <p className="text-xs text-muted-foreground">Links stay available until turned off. On-demand sites take ~30-60 s to start and stop after 10 min without visitors. Secret env vars aren’t included.</p>
        </div>
        {(!token || dirty) && <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : token ? "Update link" : "Generate link"}</Button>}
        {url && (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              readOnly
              value={url}
              aria-label="Share link"
              className="flex-1 min-w-0 h-7 px-2 rounded-md bg-muted/50 border text-[11px] font-mono truncate select-all outline-none"
            />
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0" onClick={copyLink}>
              <CopyIcon aria-hidden className="size-3" />
              Copy
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

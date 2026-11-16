"use client";

import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { CopyIcon, Share2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { convexErrorMessage } from "@/lib/convex-error";
import { useProject } from "@/features/projects/hooks/use-projects";

import { sharePath } from "../utils";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** Share only the running website, with owner-selected version and lifetime. */
export const SharePopover = ({ projectId, trigger }: { projectId: Id<"projects">; trigger?: React.ReactNode }) => {
  const project = useProject(projectId);
  const createShareLink = useAction(api.projects.createShareLink);
  const revokeShareLink = useMutation(api.projects.revokeShareLink);
  const configureShare = useMutation(api.projects.configureShare);
  const [mode, setMode] = useState<"snapshot" | "latest" | null>(null);
  const [chosenMinutes, setMinutes] = useState<0 | 15 | 30 | 60 | null>(null);
  const minutes = chosenMinutes ?? project?.shareKeepLiveMinutes ?? 0;
  const selectedMode = mode ?? project?.shareMode ?? "snapshot";
  const [saving, setSaving] = useState(false);

  const token = project?.shareToken;
  // Only set client side: the token arrives with the live project query.
  const url = token ? new URL(sharePath(token), window.location.origin).toString() : null;

  const toggle = async (on: boolean) => {
    setSaving(true);
    try {
      if (on) {
        await configureShare({ projectId, mode: selectedMode, minutes });
        const nextToken = await createShareLink({ projectId });
        if (minutes) await startPreview(nextToken);
      }
      else await revokeShareLink({ projectId });
    } catch (error) {
      toast.error(convexErrorMessage(error, on ? "Couldn't create the link" : "Couldn't turn off the link"));
    } finally {
      setSaving(false);
    }
  };

  const startPreview = async (nextToken: string) => {
    const response = await fetch(`/api/public-preview/${nextToken}`, { method: "POST" });
    const state = await response.json();
    if (!response.ok || state.status === "busy") toast.error("Preview is busy. Try again shortly.");
  };

  const saveOptions = async (updateSnapshot = false, nextMode = selectedMode, nextMinutes = minutes) => {
    if (!token) return;
    setSaving(true);
    try {
      await configureShare({ projectId, mode: nextMode, minutes: nextMinutes, updateSnapshot });
      await startPreview(token);
    } catch (error) {
      toast.error(convexErrorMessage(error, "Couldn't update the shared version"));
    } finally { setSaving(false); }
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
          <Switch
            checked={!!token}
            disabled={project === undefined || saving}
            onCheckedChange={toggle}
            aria-label="Anyone with the link can view"
          />
        </label>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            What to share
            <select aria-label="What to share" className="h-9 rounded-md border bg-background px-2 text-sm font-normal" value={selectedMode} disabled={saving || !project}
              onChange={event => { const next = event.target.value as "snapshot" | "latest"; setMode(next); void saveOptions(false, next); }}>
              <option value="snapshot">This version (snapshot now)</option>
              <option value="latest">Always the latest saved version</option>
            </select>
          </label>
          {token && selectedMode === "snapshot" && <Button variant="outline" size="sm" disabled={saving} onClick={() => void saveOptions(true)}>Update shared version</Button>}
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            How long it stays live
            <select aria-label="How long it stays live" className="h-9 rounded-md border bg-background px-2 text-sm font-normal" value={minutes} disabled={saving || !project}
              onChange={event => { const next = Number(event.target.value) as 0 | 15 | 30 | 60; setMinutes(next); void saveOptions(false, selectedMode, next); }}>
              <option value={0}>Start on visit (no time limit)</option>
              <option value={15}>Keep it live for 15 min</option>
              <option value={30}>Keep it live for 30 min</option>
              <option value={60}>Keep it live for 1 hour</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">Links stay available until turned off. On-demand sites take ~30-60 s to start and stop after 10 min without visitors. Secret env vars aren’t included.</p>
        </div>
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

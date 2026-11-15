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

/** The IDE's Share button (#260): turns the read-only link on or off and copies it. */
export const SharePopover = ({ projectId, trigger }: { projectId: Id<"projects">; trigger?: React.ReactNode }) => {
  const project = useProject(projectId);
  const createShareLink = useAction(api.projects.createShareLink);
  const revokeShareLink = useMutation(api.projects.revokeShareLink);
  const [saving, setSaving] = useState(false);

  const token = project?.shareToken;
  // Only set client side: the token arrives with the live project query.
  const url = token ? new URL(sharePath(token), window.location.origin).toString() : null;

  const toggle = async (on: boolean) => {
    setSaving(true);
    try {
      if (on) await createShareLink({ projectId });
      else await revokeShareLink({ projectId });
    } catch (error) {
      toast.error(convexErrorMessage(error, on ? "Couldn't create the link" : "Couldn't turn off the link"));
    } finally {
      setSaving(false);
    }
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
      <PopoverContent className="w-80 flex flex-col gap-3" align="end">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="block font-medium">Anyone with the link can view</span>
            <span className="block text-xs text-muted-foreground">
              Read-only code, no chat or env vars. Turning it off breaks the link.
            </span>
          </span>
          <Switch
            checked={!!token}
            disabled={project === undefined || saving}
            onCheckedChange={toggle}
            aria-label="Anyone with the link can view"
          />
        </label>
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

"use client";

import { useState } from "react";
import { RocketIcon, XIcon } from "lucide-react";
import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import { useCommandPalette } from "@/lib/command-palette";

const dismissedKey = (projectId: string) => `codenaya:ship-card-dismissed:${projectId}`;

const isDismissed = (projectId: string) => {
  try {
    return localStorage.getItem(dismissedKey(projectId)) === "1";
  } catch {
    return false;
  }
};

/**
 * Under the reply that ended a project's first build (#341): one nudge to
 * share the app. It opens the IDE's own publish dialog and export popover,
 * whose commands are only registered while the project is not published or
 * exported yet, so the card goes away once either is done, or once dismissed.
 */
export const ShipCard = ({ projectId }: { projectId: string }) => {
  const publish = useCommandPalette((state) => state.commands.publish);
  const exportToGithub = useCommandPalette((state) => state.commands["export-github"]);
  const [dismissed, setDismissed] = useState(() => isDismissed(projectId));
  if (dismissed || !publish || !exportToGithub) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissedKey(projectId), "1");
    } catch {
      // Best-effort: without storage it comes back on reload.
    }
  };

  return (
    <div
      role="group"
      aria-label="Share your app"
      className="relative flex flex-col gap-2.5 rounded-lg border border-border bg-muted/40 p-3 pr-9"
    >
      <p className="text-sm">Your app is running in the preview. Share it:</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={publish}>
          <RocketIcon className="size-3.5" />
          Publish to showcase
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={exportToGithub}>
          <FaGithub className="size-3.5" />
          Export to GitHub
        </Button>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute right-1.5 top-1.5 size-7 text-muted-foreground"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};

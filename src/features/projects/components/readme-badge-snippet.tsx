"use client";

import { CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { badgeSnippets } from "@/lib/badge-snippets";
import { copyToClipboard } from "@/lib/clipboard";

import { importPath, parseGithubRepo } from "../utils/github-repo";

/** "Open in Codenaya" README badge for an exported repo (#231). */
export const ReadmeBadgeSnippet = ({ repoUrl }: { repoUrl: string }) => {
  const slug = parseGithubRepo(repoUrl);
  if (!slug) return null;
  const { markdown } = badgeSnippets("open", window.location.origin, importPath(slug));

  return (
    <div className="w-full space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Add a README badge</p>
        <img src="/badges/open-in-codenaya.svg" alt="" height={28} className="h-5 w-auto" />
      </div>
      <div className="flex items-center gap-1">
        <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {markdown}
        </code>
        <Button
          size="icon"
          variant="outline"
          className="size-7 shrink-0"
          aria-label="Copy README badge"
          onClick={() => copyToClipboard(markdown, "Badge copied")}
        >
          <CopyIcon className="size-3.5" />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Visitors can open a public repo in Codenaya.</p>
    </div>
  );
};

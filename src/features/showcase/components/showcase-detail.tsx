"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import {
  ArrowUpIcon,
  ArrowDownIcon,
  DownloadIcon,
  EyeIcon,
  GitForkIcon,
  LinkIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SIGN_IN_URL } from "@/features/auth/constants";

import type { ShowcaseProject } from "../types";
import {
  useShowcaseById,
  useUserVote,
  useVote,
  useIncrementView,
} from "../hooks/use-showcase";
import { authRedirectUrl, showcasePath, useRemix } from "../hooks/use-remix";

interface ShowcaseDetailProps {
  project: ShowcaseProject;
  /** Element for the title, e.g. `DialogTitle` inside a dialog. */
  TitleAs?: React.ElementType;
}

/**
 * A showcase project's screenshot, details, votes and actions (Copy link,
 * Remix). Shared by the dashboard dialog and the public /showcase/[id] page.
 */
export const ShowcaseDetail = ({ project, TitleAs = "h1" }: ShowcaseDetailProps) => {
  const router = useRouter();
  const vote = useVote();
  const incrementView = useIncrementView();
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const { remix, isRemixing } = useRemix(project._id);

  // Live query for realtime vote counts
  const liveProject = useShowcaseById(project._id);
  const userVote = useUserVote(project._id);

  // Use live data when available, fall back to prop
  const displayProject = liveProject ?? project;

  // Views are counted per signed-in user, so wait until Convex has the token.
  useEffect(() => {
    if (isAuthenticated) incrementView({ id: project._id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project._id, isAuthenticated]);

  const handleVote = async (direction: "up" | "down") => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      router.push(authRedirectUrl(SIGN_IN_URL, showcasePath(project._id)));
      return;
    }
    try {
      await vote({ showcaseProjectId: displayProject._id, vote: direction });
    } catch {
      toast.error("Failed to vote");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        new URL(showcasePath(project._id), window.location.origin).toString(),
      );
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <>
      <div className="aspect-video w-full bg-muted/20 overflow-hidden">
        {displayProject.previewUrl ? (
          <img
            src={displayProject.previewUrl}
            alt={displayProject.title}
            className="size-full object-cover"
          />
        ) : (
          <div className="size-full flex items-center justify-center text-muted-foreground/30">
            <span className="text-sm font-mono">No preview available</span>
          </div>
        )}
      </div>

      <div className="p-6 space-y-5">
        <div className="flex flex-col gap-2 text-left">
          <TitleAs className="text-xl font-bold break-words">{displayProject.title}</TitleAs>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {displayProject.ownerAvatarUrl && (
              <img
                src={displayProject.ownerAvatarUrl}
                alt={displayProject.ownerName}
                className="size-5 rounded-full"
              />
            )}
            <span>by {displayProject.ownerName}</span>
          </div>
        </div>

        {displayProject.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {displayProject.description}
          </p>
        )}

        <div className="space-y-3">
          {displayProject.techStack.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                Tech Stack
              </p>
              <div className="flex flex-wrap gap-1.5">
                {displayProject.techStack.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {displayProject.designStyle.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                Design Style
              </p>
              <div className="flex flex-wrap gap-1.5">
                {displayProject.designStyle.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground py-2 border-t border-border/40">
          <span className="flex items-center gap-1">
            <EyeIcon className="size-3.5" />
            {displayProject.viewCount} views
          </span>
          <span className="flex items-center gap-1">
            <DownloadIcon className="size-3.5" />
            {displayProject.importCount} imports
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <div className="flex items-center gap-1 border border-border/50 rounded-lg p-0.5">
            <Button
              size="sm"
              variant={userVote === "up" ? "default" : "ghost"}
              className="h-8 px-3 gap-1.5"
              aria-label={`Upvote (${displayProject.upvotes})`}
              onClick={() => handleVote("up")}
            >
              <ArrowUpIcon className="size-3.5" />
              {displayProject.upvotes}
            </Button>
            <div className="w-px h-5 bg-border/40" />
            <Button
              size="sm"
              variant={userVote === "down" ? "default" : "ghost"}
              className="h-8 px-3 gap-1.5"
              aria-label={`Downvote (${displayProject.downvotes})`}
              onClick={() => handleVote("down")}
            >
              <ArrowDownIcon className="size-3.5" />
              {displayProject.downvotes}
            </Button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={copyLink} className="gap-2">
              <LinkIcon className="size-4" />
              Copy link
            </Button>
            <Button
              onClick={remix}
              disabled={isRemixing || isAuthLoading}
              className="gap-2 bg-brand text-white hover:bg-brand/90"
            >
              <GitForkIcon className="size-4" />
              {isRemixing ? "Remixing..." : "Remix"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

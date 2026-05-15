"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpIcon,
  ArrowDownIcon,
  DownloadIcon,
  EyeIcon,
  ImportIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { Id, Doc } from "../../../../convex/_generated/dataModel";
import {
  useShowcaseById,
  useUserVote,
  useVote,
  useImportToWorkspace,
  useIncrementView,
} from "../hooks/use-showcase";

type ShowcaseProject = Doc<"showcaseProjects"> & { previewUrl: string | null };

interface ShowcaseDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ShowcaseProject | null;
}

export const ShowcaseDetailDialog = ({
  open,
  onOpenChange,
  project,
}: ShowcaseDetailDialogProps) => {
  const router = useRouter();
  const vote = useVote();
  const importToWorkspace = useImportToWorkspace();
  const incrementView = useIncrementView();

  // Live query for realtime vote counts
  const liveProject = useShowcaseById(project?._id);
  const userVote = useUserVote(project?._id);

  // Use live data when available, fall back to prop
  const displayProject = liveProject ?? project;

  useEffect(() => {
    if (open && project) {
      incrementView({ id: project._id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?._id]);

  if (!displayProject) return null;

  const handleVote = async (direction: "up" | "down") => {
    try {
      await vote({ showcaseProjectId: displayProject._id, vote: direction });
    } catch {
      toast.error("Failed to vote");
    }
  };

  const handleImport = async () => {
    try {
      const newProjectId = await importToWorkspace({
        showcaseProjectId: displayProject._id,
      });
      toast.success("Project imported to your workspace!");
      onOpenChange(false);
      router.push(`/projects/${newProjectId}`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to import");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto p-0">
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
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl font-bold">
              {displayProject.title}
            </DialogTitle>
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
          </DialogHeader>

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

          <div className="flex items-center gap-3 pt-2">
            <div className="flex items-center gap-1 border border-border/50 rounded-lg p-0.5">
              <Button
                size="sm"
                variant={userVote === "up" ? "default" : "ghost"}
                className="h-8 px-3 gap-1.5"
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
                onClick={() => handleVote("down")}
              >
                <ArrowDownIcon className="size-3.5" />
                {displayProject.downvotes}
              </Button>
            </div>

            <Button
              onClick={handleImport}
              className="ml-auto gap-2 bg-brand text-white hover:bg-brand/90"
            >
              <ImportIcon className="size-4" />
              Import to Workspace
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

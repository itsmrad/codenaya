"use client";

import { ArrowUpIcon, ArrowDownIcon, DownloadIcon, EyeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Doc } from "../../../../convex/_generated/dataModel";

type ShowcaseProject = Doc<"showcaseProjects"> & { previewUrl: string | null };

interface ShowcaseCardProps {
  project: ShowcaseProject;
  onClick: () => void;
}

export const ShowcaseCard = ({ project, onClick }: ShowcaseCardProps) => {
  return (
    <button
      onClick={onClick}
      className="group text-left w-full rounded-xl border border-border/50 bg-card overflow-hidden hover:border-border/80 hover:shadow-md transition-all duration-200"
    >
      <div className="aspect-video w-full bg-muted/30 overflow-hidden relative">
        {project.previewUrl ? (
          <img
            src={project.previewUrl}
            alt={project.title}
            className="size-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
        ) : (
          <div className="size-full flex items-center justify-center text-muted-foreground/30">
            <span className="text-xs font-mono">No preview</span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground truncate group-hover:text-brand transition-colors">
            {project.title}
          </h3>
          <p className="text-xs text-muted-foreground truncate">
            by {project.ownerName}
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          {project.techStack.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
              {tag}
            </Badge>
          ))}
          {project.techStack.length > 3 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              +{project.techStack.length - 3}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowUpIcon className="size-3" />
            {project.upvotes}
          </span>
          <span className="flex items-center gap-1">
            <EyeIcon className="size-3" />
            {project.viewCount}
          </span>
          <span className="flex items-center gap-1">
            <DownloadIcon className="size-3" />
            {project.importCount}
          </span>
        </div>
      </div>
    </button>
  );
};

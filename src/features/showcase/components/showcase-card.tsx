"use client";

import Link from "next/link";
import { ArrowUpIcon, ArrowDownIcon, DownloadIcon, EyeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProjectCover } from "@/components/project-cover";
import type { ShowcaseProject } from "../types";

type ShowcaseCardProps = {
  project: ShowcaseProject;
} & ({ href: string; onClick?: never } | { onClick: () => void; href?: never });

export const CARD_CLASS =
  "group block text-left w-full rounded-xl border border-border/50 bg-card overflow-hidden hover:border-border/80 hover:shadow-md transition-all duration-200";

/** A showcase project card: a link to its page, or a button (e.g. to open a dialog). */
export const ShowcaseCard = ({ project, href, onClick }: ShowcaseCardProps) => {
  const body = (
    <>
      <div className="aspect-video w-full bg-muted/30 overflow-hidden relative">
        {project.previewUrl ? (
          <img
            src={project.previewUrl}
            alt={project.title}
            className="size-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
        ) : (
          <ProjectCover seed={project._id} className="size-full" />
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
    </>
  );

  return href ? (
    <Link href={href} className={CARD_CLASS}>
      {body}
    </Link>
  ) : (
    <button onClick={onClick} className={CARD_CLASS}>
      {body}
    </button>
  );
};

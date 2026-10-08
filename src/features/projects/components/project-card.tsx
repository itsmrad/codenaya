"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { FaGithub } from "react-icons/fa";
import {
  AlertCircleIcon,
  ExternalLinkIcon,
  LinkIcon,
  MoreHorizontalIcon,
} from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProjectCover, getCoverHue, getInitials } from "@/components/project-cover";

import { Doc } from "../../../../convex/_generated/dataModel";
import { useProjectRename } from "../hooks/use-project-rename";
import { DeleteProjectDialog, ProjectActionsMenu } from "./project-actions";

const StatusBadge = ({ project }: { project: Doc<"projects"> }) => {
  const base =
    "absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full border border-border/60 bg-background/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm";

  if (project.importStatus === "importing") {
    return (
      <span className={base}>
        <span className="size-1.5 animate-pulse rounded-full bg-brand" />
        Importing…
      </span>
    );
  }
  if (project.importStatus === "failed") {
    return (
      <span className={`${base} text-destructive`}>
        <AlertCircleIcon className="size-3" />
        Import failed
      </span>
    );
  }
  if (project.importStatus === "completed" || project.exportStatus === "completed") {
    return (
      <span className={`${base} text-muted-foreground`}>
        <FaGithub className="size-3" />
        GitHub
      </span>
    );
  }
  return null;
};

/**
 * A project in the dashboard grid: a generated cover, name, last edit and
 * status. The menu holds link actions plus rename, duplicate and delete.
 */
export const ProjectCard = ({ project }: { project: Doc<"projects"> }) => {
  const href = `/projects/${project._id}`;
  const rename = useProjectRename(project);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const body = (
    <>
      <div className="relative overflow-hidden rounded-t-xl">
        <ProjectCover seed={project._id} className="aspect-16/10 w-full" />
        <div className="pointer-events-none absolute inset-0 rounded-t-xl ring-1 ring-inset ring-foreground/5" />
        <StatusBadge project={project} />
      </div>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white"
          style={{ background: `oklch(0.6 0.15 ${getCoverHue(project._id)})` }}
        >
          {getInitials(project.name)}
        </span>
        <div className="min-w-0 flex-1">
          {rename.isRenaming ? (
            <input
              {...rename.inputProps}
              className="-mx-1 w-[calc(100%+0.5rem)] rounded bg-transparent px-1 text-sm font-medium text-foreground outline-none ring-1 ring-brand/40 aria-invalid:ring-destructive"
            />
          ) : (
            <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            Edited {formatDistanceToNow(project.updatedAt, { addSuffix: true })}
          </p>
        </div>
      </div>
    </>
  );

  return (
    <div className="group relative rounded-xl border border-border/60 bg-card transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-border hover:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.25)] motion-reduce:hover:translate-y-0">
      {rename.isRenaming ? (
        // While renaming, the card is not a link so clicks land in the input.
        <div className="rounded-xl">{body}</div>
      ) : (
        <Link href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {body}
        </Link>
      )}

      <ProjectActionsMenu
        project={project}
        onRename={rename.start}
        onDelete={() => setDeleteOpen(true)}
        trigger={
          <button
            aria-label={`Actions for ${project.name}`}
            className="absolute right-2.5 top-2.5 grid size-7 place-items-center rounded-md border border-border/60 bg-background/85 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        }
      >
        <DropdownMenuItem onClick={() => window.open(href, "_blank", "noopener")}>
          <ExternalLinkIcon />
          Open in new tab
        </DropdownMenuItem>
        <DropdownMenuItem onClick={copyLink}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
      </ProjectActionsMenu>
      <DeleteProjectDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  );
};

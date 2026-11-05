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
import { MENU_ITEM } from "@/components/menu-chrome";
import { ProjectCover, getCoverHue, getInitials } from "@/components/project-cover";

import { Doc } from "../../../../convex/_generated/dataModel";
import { DeleteProjectDialog, ProjectActionsMenu, RenameProjectDialog } from "./project-actions";

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
 * status. The menu holds link actions plus rename (in a dialog), duplicate and delete.
 */
export const ProjectCard = ({ project }: { project: Doc<"projects"> }) => {
  const href = `/projects/${project._id}`;
  const [renameOpen, setRenameOpen] = useState(false);
  // Remounts the rename dialog per opening, so it starts from the current name.
  const [renameKey, setRenameKey] = useState(0);
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
      <div className="relative overflow-hidden rounded-md border border-border transition-colors duration-200 group-hover:border-brand/40">
        <ProjectCover
          seed={project._id}
          className="aspect-16/10 w-full transition-transform duration-500 ease-out group-hover:scale-[1.03] motion-reduce:group-hover:scale-100"
        />
        <StatusBadge project={project} />
      </div>
      <div className="flex items-center gap-2.5 pt-3">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white"
          style={{ background: `oklch(0.6 0.15 ${getCoverHue(project._id)})` }}
        >
          {getInitials(project.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Edited {formatDistanceToNow(project.updatedAt, { addSuffix: true })}
          </p>
        </div>
      </div>
    </>
  );

  return (
    <div className="group relative">
      <Link href={href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {body}
      </Link>

      <ProjectActionsMenu
        project={project}
        onRename={() => {
          setRenameKey((key) => key + 1);
          setRenameOpen(true);
        }}
        onDelete={() => setDeleteOpen(true)}
        trigger={
          <button
            aria-label={`Actions for ${project.name}`}
            className="absolute right-2.5 top-2.5 grid size-7 place-items-center rounded-md border border-border bg-background/85 data-[state=open]:border-brand/40 data-[state=open]:text-foreground text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        }
      >
        <DropdownMenuItem onClick={() => window.open(href, "_blank", "noopener")} className={MENU_ITEM}>
          <ExternalLinkIcon />
          Open in new tab
        </DropdownMenuItem>
        <DropdownMenuItem onClick={copyLink} className={MENU_ITEM}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
      </ProjectActionsMenu>
      <RenameProjectDialog key={renameKey} project={project} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteProjectDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  );
};

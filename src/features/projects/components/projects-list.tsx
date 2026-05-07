import Link from "next/link";
import { FaGithub } from "react-icons/fa";
import { formatDistanceToNow } from "date-fns";
import { AlertCircleIcon, ArrowRightIcon, GlobeIcon, Loader2Icon, ClockIcon } from "lucide-react";

import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";

import { Doc } from "../../../../convex/_generated/dataModel";

import { useProjectsPartial } from "../hooks/use-projects";

const formatTimestamp = (timestamp: number) => {
  return formatDistanceToNow(new Date(timestamp), { 
    addSuffix: true
  });
};

const getProjectIcon = (project: Doc<"projects">) => {
  if (project.importStatus === "completed") {
    return <FaGithub className="size-4 text-muted-foreground" />
  }

  if (project.importStatus === "failed") {
    return <AlertCircleIcon className="size-4 text-muted-foreground" />;
  }

  if (project.importStatus === "importing") {
    return (
      <Loader2Icon className="size-4 text-muted-foreground animate-spin" />
    );
  }

  return <GlobeIcon className="size-4 text-muted-foreground" />;
}

interface ProjectsListProps {
  onViewAll: () => void;
}

const ContinueCard = ({ 
  data
}: {
  data: Doc<"projects">;
}) => {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 px-1">
        <ClockIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Jump back in
        </span>
      </div>
      <Button
        variant="outline"
        asChild
        className="h-auto items-start justify-start p-4 bg-muted/20 hover:bg-muted/50 border-border/50 rounded-2xl flex flex-col gap-3 transition-all group"
      >
        <Link href={`/projects/${data._id}`}>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <div className="bg-background p-2 rounded-lg border border-border/50 shadow-sm">
                {getProjectIcon(data)}
              </div>
              <span className="font-semibold text-base truncate">
                {data.name}
              </span>
            </div>
            <div className="bg-background p-1.5 rounded-full border border-border/50 shadow-sm opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all">
              <ArrowRightIcon className="size-3.5 text-foreground" />
            </div>
          </div>
          <div className="pl-[2.75rem]">
            <span className="text-xs text-muted-foreground font-medium">
              Last updated {formatTimestamp(data.updatedAt)}
            </span>
          </div>
        </Link>
      </Button>
    </div>
  )
};

const ProjectItem = ({ 
  data
}: {
  data: Doc<"projects">;
}) => {
  return (
    <Link 
      href={`/projects/${data._id}`}
      className="text-sm font-medium hover:bg-muted/30 p-2 -mx-2 rounded-xl flex items-center justify-between w-full group transition-all"
    >
      <div className="flex items-center gap-3">
        <div className="p-1.5 bg-muted/30 rounded-md border border-border/50 group-hover:bg-background group-hover:shadow-sm transition-all">
          {getProjectIcon(data)}
        </div>
        <span className="truncate text-foreground/80 group-hover:text-foreground transition-colors">{data.name}</span>
      </div>
      <span className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors">
        {formatTimestamp(data.updatedAt)}
      </span>
    </Link>
  );
};

export const ProjectsList = ({ 
  onViewAll
}: ProjectsListProps) => {
  const projects = useProjectsPartial(6);

  if (projects === undefined) {
    return (
      <div className="w-full flex items-center justify-center py-8">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const [mostRecent, ...rest] = projects;

  return (
    <div className="flex flex-col gap-6">
      {mostRecent ? <ContinueCard data={mostRecent} /> : null}
      
      {rest.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent projects
            </span>
            <button
              onClick={onViewAll}
              className="flex items-center gap-2 text-muted-foreground text-xs font-medium hover:text-foreground transition-colors group/view-all"
            >
              <span>View all</span>
              <Kbd className="bg-muted/30 border-border/50 px-1.5 py-0.5 rounded group-hover/view-all:bg-background group-hover/view-all:shadow-sm transition-all">
                ⌘K
              </Kbd>
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {rest.map((project) => (
              <ProjectItem
                key={project._id}
                data={project}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
};

import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { useProjectsPartial } from "@/features/projects/hooks/use-projects"
import { Doc } from "@convex/_generated/dataModel"
import { AlertCircleIcon,ArrowRightIcon, GlobeIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { FaGithub } from "react-icons/fa"
import { Button } from "@/components/ui/button"

const formatTimeStamp = ( timestamp: number ) => {
  return formatDistanceToNow(new Date(timestamp), {addSuffix: true})
}

const getProjectIcon = ( {project} : {project: Doc<"projects">}) => {
  if (project.importStatus === "completed") {
    return (
      <FaGithub className="size-4 text-muted-foreground" />
    )
  }
  if (project.importStatus === "failed") {
    return (
      <AlertCircleIcon className="size-4 text-muted-foreground" />
    )
  }
  if (project.importStatus === "importing") {
    return (
      <Loader2Icon className="size-4 text-muted-foreground animate-spin" />
    )
  }

  return <GlobeIcon className="size-4 text-muted-foreground" />
}

interface projectListProps {
  onViewAll: () => void
}

const ContinueCard = ({ data } : {
  data: Doc<"projects">
}) => {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">
        Last updated
      </span>
      <Button
        variant={"outline"}
        asChild
        className="h-auto items-start justify-start p-4 bg-background border rounded-none flex flex-col gap-2"
      >
        <Link href={`/projects/${data._id}`} className="group" >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {getProjectIcon({project: data})}
              <span className="font-medium truncate">
                {data.name}
              </span>
              <ArrowRightIcon className="size-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatTimeStamp(data.updatedAt)}
          </span>
        </Link>
      </Button>
    </div>
  )
};

const ProjectItem = ({ data } : {
  data: Doc<"projects">
}) => {
  return (
    <Link href={`/projects/${data._id}`} className="text-sm text-foreground/60 font-medium hover:text-foreground py-1 flex items-center justify-between w-full group">
      <div className="flex items-center gap-2">
        {getProjectIcon({project: data})}
        <span className="truncate">
          {data.name}
        </span>
      </div>
      <span className="text-xs text-muted-foreground group-hover:text-foreground/60 transition-colors">
        {formatTimeStamp(data.updatedAt)}
      </span>
    </Link>
  )
}

export const ProjectsList = ({ onViewAll }: projectListProps) => {

  const projects = useProjectsPartial(6)

  if (projects === undefined) {
    return <Spinner className="size-4 text-ring " />
  }

  const [mostRecent, ...rest] = projects

  return (
    <div className="flex flex-col gap-4">
      {mostRecent ? <ContinueCard data={mostRecent} /> : null}
      {rest.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Recent Projects
            </span>
            <button 
              className="flex items-center gap-2 text-muted-foreground text-xs hover:text-foreground transition-colors"
              onClick={onViewAll}
            >
              <span>View all</span>
              <Kbd className="bg-accent border">⌘K</Kbd>
            </button>
          </div>
          <ul>
            {rest.map((project) => (
              <ProjectItem key={project._id} data={project} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
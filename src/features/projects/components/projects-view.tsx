"use client";

import { Poppins } from "next/font/google";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SparkleIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { FaGithub } from "react-icons/fa";
import { ProjectsList } from "@/features/projects/components/projects-list";
import { useCreateProject } from "@/features/projects/hooks/use-projects";
import {
	adjectives,
	animals,
	colors,
	uniqueNamesGenerator,
} from "unique-names-generator";
import { useEffect, useState } from "react";
import { ProjectCommandDialog } from "./projects-command-dialog";
import Image from "next/image";

const font = Poppins({
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
});

export const ProjectsView = () => {
	const createProject = useCreateProject();
  const [commandDialogOpen, setCommandDialogOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "k"){
          e.preventDefault()
          setCommandDialogOpen((prev) => !prev)
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [])

	return (
    <>
      <ProjectCommandDialog 
        open={commandDialogOpen}
        onOpenChange={setCommandDialogOpen}
      />
      <div className="min-h-screen bg-sidebar flex flex-col items-center justify-center p-6 md:p-16">
        <div className="w-full max-w-sm mx-auto flex flex-col gap-4 items-center">
          <div className="flex justify-between gap-4 w-full items-center">
            <div className="flex items-center gap-2 w-full group/logo">
              <Image
                src="/logo.svg"
                alt="Codenaya"
                width={46}
                height={46}
              />
              <h1
                className={cn(
                  "text-4xl md:text-5xl font-semibold",
                  font.className,
                )}>
                CodeNaya
              </h1>
            </div>
          </div>
          <div className="flex flex-col gap-4 w-full">
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-full items-start justify-start p-4 bg-background border flex flex-col rounded-none gap-6"
                onClick={() => {
                  const projectName = uniqueNamesGenerator({
                    dictionaries: [adjectives, animals, colors],
                    separator: "-",
                    length: 3,
                  });
                  createProject({
                    name: projectName,
                  });
                }}>
                <div className="flex justify-between w-full items-center">
                  <SparkleIcon className="size-4" />
                  <Kbd className="bg-accent border">⌘J</Kbd>
                </div>
                <div>
                  <span className="text-sm font-medium">New</span>
                </div>
              </Button>
              <Button
                variant="outline"
                className="h-full items-start justify-start p-4 bg-background border flex flex-col rounded-none gap-6">
                <div className="flex justify-between w-full items-center">
                  <FaGithub className="size-4" />
                  <Kbd className="bg-accent border">⌘I</Kbd>
                </div>
                <div>
                  <span className="text-sm font-medium">Import</span>
                </div>
              </Button>
            </div>
            <ProjectsList onViewAll={() => setCommandDialogOpen(true)} />
          </div>
        </div>
      </div>
    </>
	);
};

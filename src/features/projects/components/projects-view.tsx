"use client";

import { Poppins } from "next/font/google";
import { SparkleIcon } from "lucide-react";
import { FaGithub } from "react-icons/fa";
import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

import { ProjectsList } from "./projects-list";
import { ProjectsCommandDialog } from "./projects-command-dialog";
import { ImportGithubDialog } from "./import-github-dialog";
import { NewProjectDialog } from "./new-project-dialog";

const font = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
})

export const ProjectsView = () => {
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [isMac] = useState(() => typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "k") {
          e.preventDefault();
          setCommandDialogOpen(true);
        }
        if (e.key === "i") {
          e.preventDefault();
          setImportDialogOpen(true);
        }
        if (e.key === "j") {
          e.preventDefault();
          setNewProjectDialogOpen(true);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <ProjectsCommandDialog
        open={commandDialogOpen}
        onOpenChange={setCommandDialogOpen}
      />
      <ImportGithubDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
      />
      <div className="min-h-screen bg-muted/20 flex flex-col items-center justify-center p-6 md:p-16 relative isolate overflow-hidden">
        {/* User account dropdown */}
        <div className="absolute top-6 right-6 z-50">
          <UserButton />
        </div>

        {/* Subtle background glow effect for spatial depth */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none -z-10" />

        <div className="w-full max-w-xl mx-auto flex flex-col gap-8 items-center relative z-10">
          
          <div className="flex items-center gap-4 w-full justify-center group/logo">
            <div className="bg-background p-3 rounded-2xl shadow-sm border border-border/50 flex items-center justify-center">
              <img src="/logo.svg" alt="Codenaya" className="size-[32px] md:size-[40px]" />
            </div>
            <h1 className={cn(
              "text-4xl md:text-5xl font-semibold tracking-tight text-foreground/90",
              font.className,
            )}>
              Codenaya
            </h1>
          </div>

          <div className="flex flex-col gap-6 w-full bg-background border border-border/50 shadow-sm rounded-[2rem] p-6 md:p-8 overflow-hidden relative">
            <div className="grid grid-cols-2 gap-4">
              <Button
                variant="outline"
                onClick={() => setNewProjectDialogOpen(true)}
                className="h-auto items-start justify-start p-5 bg-muted/20 hover:bg-muted/50 border border-border/50 flex flex-col gap-6 rounded-2xl transition-all"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="bg-background p-2 rounded-xl border border-border/50 shadow-sm">
                    <SparkleIcon className="size-4" />
                  </div>
                  <Kbd className="bg-background border-border/50 shadow-sm px-2 py-1 rounded-lg">
                    {isMac ? "⌘J" : "Ctrl+J"}
                  </Kbd>
                </div>
                <div>
                  <span className="text-base font-medium">
                    New Project
                  </span>
                </div>
              </Button>
              
              <Button
                variant="outline"
                onClick={() => setImportDialogOpen(true)}
                className="h-auto items-start justify-start p-5 bg-muted/20 hover:bg-muted/50 border border-border/50 flex flex-col gap-6 rounded-2xl transition-all"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="bg-background p-2 rounded-xl border border-border/50 shadow-sm">
                    <FaGithub className="size-4" />
                  </div>
                  <Kbd className="bg-background border-border/50 shadow-sm px-2 py-1 rounded-lg">
                    {isMac ? "⌘I" : "Ctrl+I"}
                  </Kbd>
                </div>
                <div>
                  <span className="text-base font-medium">
                    Import GitHub
                  </span>
                </div>
              </Button>
            </div>

            <div className="w-full h-px bg-border/40 my-2" />

            <ProjectsList onViewAll={() => setCommandDialogOpen(true)} />
          </div>

        </div>
      </div>
    </>
  );
};

"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  EyeIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { SKILLS_SETTINGS_URL } from "@/features/settings/nav";

import type { ProjectSkillSummary } from "../types";
import {
  skillErrorMessage,
  useProjectSkills,
  useRemoveSkill,
  useSetProjectSkillEnabled,
} from "../hooks/use-skills";
import { SkillEditorDialog, type SkillEditorTarget } from "./skill-editor-dialog";

import { Id } from "../../../../convex/_generated/dataModel";

const iconButtonClassName =
  "size-7 text-muted-foreground hover:text-foreground";

/** `user:<id>` keys carry the stored skill's id. */
const storedSkillId = (skill: ProjectSkillSummary) =>
  skill.key.slice("user:".length) as Id<"skills">;

/**
 * Chooses which skills this project's agent may use: its own project skills,
 * plus built-in and library skills, which stay off until enabled here.
 */
export const ProjectSkillsPanel = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) => {
  const skills = useProjectSkills(projectId);
  const setEnabled = useSetProjectSkillEnabled();
  const removeSkill = useRemoveSkill();

  const [editorTarget, setEditorTarget] = useState<SkillEditorTarget | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] =
    useState<ProjectSkillSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (skills === undefined) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Loading skills...
      </div>
    );
  }

  const projectSkills = skills.filter((skill) => skill.scope === "project");
  const librarySkills = skills.filter((skill) => skill.scope !== "project");
  const allLibraryEnabled = librarySkills.every((skill) => skill.enabled);

  const toggle = async (skill: ProjectSkillSummary, enabled: boolean) => {
    try {
      await setEnabled({ projectId, skillKey: skill.key, enabled });
    } catch (error) {
      toast.error(skillErrorMessage(error, `Unable to update ${skill.name}`));
    }
  };

  // Library switches only: project skills keep their own state. Convex runs a
  // client's mutations in order, so these don't contend with each other.
  const toggleAllLibrary = async () => {
    const enabled = !allLibraryEnabled;
    try {
      await Promise.all(
        librarySkills
          .filter((skill) => skill.enabled !== enabled)
          .map((skill) =>
            setEnabled({ projectId, skillKey: skill.key, enabled }),
          ),
      );
    } catch (error) {
      toast.error(skillErrorMessage(error, "Unable to update skills"));
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await removeSkill({ skillId: storedSkillId(pendingDelete) });
      toast.success(`Deleted ${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (error) {
      toast.error(
        skillErrorMessage(error, `Unable to delete ${pendingDelete.name}`),
      );
    } finally {
      setDeleting(false);
    }
  };

  const renderRow = (skill: ProjectSkillSummary) => (
    <li key={skill.key} className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs font-medium">
            {skill.name}
          </span>
          {skill.scope === "builtin" && (
            <Badge variant="secondary">Built-in</Badge>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {skill.scope === "builtin" && (
          <Button
            size="icon"
            variant="ghost"
            className={iconButtonClassName}
            title="View"
            aria-label={`View ${skill.name}`}
            onClick={() =>
              setEditorTarget({ kind: "builtin", name: skill.name })
            }
          >
            <EyeIcon className="size-3.5" />
          </Button>
        )}
        {skill.scope === "project" && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className={iconButtonClassName}
              title="Edit"
              aria-label={`Edit ${skill.name}`}
              onClick={() =>
                setEditorTarget({ kind: "edit", skillId: storedSkillId(skill) })
              }
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className={`${iconButtonClassName} hover:text-destructive`}
              title="Delete"
              aria-label={`Delete ${skill.name}`}
              onClick={() => setPendingDelete(skill)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </>
        )}
        <Switch
          className="ml-1.5 mt-1.5"
          checked={skill.enabled}
          onCheckedChange={(checked) => toggle(skill, checked)}
          aria-label={`Enable ${skill.name}`}
        />
      </div>
    </li>
  );

  return (
    <div className="min-w-0 space-y-5">
      <section aria-labelledby="project-skills-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3
            id="project-skills-heading"
            className="text-xs font-medium text-muted-foreground"
          >
            This project
          </h3>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setEditorTarget({ kind: "create", scope: "project" })}
          >
            <PlusIcon aria-hidden="true" />
            New skill
          </Button>
        </div>
        {projectSkills.length === 0 ? (
          <Empty className="border border-dashed p-6 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle className="text-sm">No project skills yet</EmptyTitle>
              <EmptyDescription className="text-xs">
                Project skills exist only in this project, for conventions the
                agent should follow here and nowhere else.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y divide-border/50 rounded-md border border-border/50">
            {projectSkills.map(renderRow)}
          </ul>
        )}
      </section>

      <section aria-labelledby="library-skills-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            id="library-skills-heading"
            className="text-xs font-medium text-muted-foreground"
          >
            From your library
          </h3>
          <div className="flex items-center gap-1">
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
              <Link href={SKILLS_SETTINGS_URL}>Manage library</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={toggleAllLibrary}
            >
              {allLibraryEnabled ? "Disable all" : "Enable all"}
            </Button>
          </div>
        </div>
        <ul className="divide-y divide-border/50 rounded-md border border-border/50">
          {librarySkills.map(renderRow)}
        </ul>
        {librarySkills.every((skill) => skill.scope === "builtin") && (
          <p className="text-xs text-muted-foreground">
            Skills you save to your library show up here, off until you enable
            them for a project.
          </p>
        )}
      </section>

      <SkillEditorDialog
        target={editorTarget}
        onTargetChange={setEditorTarget}
        projectId={projectId}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent in this project will stop using it. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                // Keep the dialog open while the mutation is in flight.
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

/** The Skills panel as a dialog, opened from the IDE navbar. */
export const ProjectSkillsDialog = ({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: Id<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Skills</DialogTitle>
        <DialogDescription>
          Choose the skills this project&apos;s agent can use. Library skills
          are off until you enable them here.
        </DialogDescription>
      </DialogHeader>
      {open && <ProjectSkillsPanel projectId={projectId} />}
    </DialogContent>
  </Dialog>
);

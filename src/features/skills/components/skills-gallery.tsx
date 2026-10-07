"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ItemGroup } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

import { BUILTIN_SKILL_ATTRIBUTIONS, BUILTIN_SKILLS } from "../builtin";
import {
  skillErrorMessage,
  useLibrarySkills,
  useRemoveSkill,
} from "../hooks/use-skills";
import { SkillCard } from "./skill-card";
import { SkillEditorDialog, type SkillEditorTarget } from "./skill-editor-dialog";

import { Doc } from "../../../../convex/_generated/dataModel";

const matches = (
  skill: { name: string; description: string },
  search: string,
) => {
  const needle = search.trim().toLowerCase();
  return (
    !needle ||
    skill.name.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  );
};

const projectCountLabel = (count: number) =>
  count === 0
    ? "Not enabled in any project"
    : `Used in ${count} ${count === 1 ? "project" : "projects"}`;

/**
 * Settings → Skills: browse the built-in skills and manage the user's library.
 * Library skills are enabled per project from the IDE's Skills panel.
 */
export const SkillsGallery = () => {
  const library = useLibrarySkills();
  const removeSkill = useRemoveSkill();

  const [search, setSearch] = useState("");
  const [editorTarget, setEditorTarget] = useState<SkillEditorTarget | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<Doc<"skills"> | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => setEditorTarget({ kind: "create", scope: "library" });

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await removeSkill({ skillId: pendingDelete._id });
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

  const builtins = BUILTIN_SKILLS.filter((skill) => matches(skill, search));

  const renderLibrary = () => {
    if (library === undefined) {
      return (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading skills...
        </div>
      );
    }

    if (library.length === 0) {
      return (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>No skills in your library yet</EmptyTitle>
            <EmptyDescription>
              Write a skill once and enable it in any project: conventions,
              recipes or checklists the agent should follow.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={openCreate}>
              <PlusIcon aria-hidden="true" />
              New skill
            </Button>
          </EmptyContent>
        </Empty>
      );
    }

    const shown = library.filter((skill) => matches(skill, search));
    if (shown.length === 0) {
      return (
        <p className="py-4 text-center text-sm text-muted-foreground">
          No skills match &ldquo;{search.trim()}&rdquo;.
        </p>
      );
    }

    return (
      <ItemGroup aria-label="Library skills" className="gap-2">
        {shown.map((skill) => (
          <SkillCard
            key={skill._id}
            name={skill.name}
            description={skill.description}
            source={skill.source}
            meta={projectCountLabel(skill.projectCount)}
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Edit ${skill.name}`}
                  onClick={() =>
                    setEditorTarget({ kind: "edit", skillId: skill._id })
                  }
                >
                  <PencilIcon aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${skill.name}`}
                  onClick={() => setPendingDelete(skill)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </>
            }
          />
        ))}
      </ItemGroup>
    );
  };

  return (
    <>
      <Alert>
        <InfoIcon aria-hidden="true" />
        <AlertTitle className="line-clamp-none">
          Library skills are off in every project until you enable them
        </AlertTitle>
        <AlertDescription>
          Open a project and choose Skills in the navbar to turn skills on for
          that project.
        </AlertDescription>
      </Alert>

      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills"
          aria-label="Search skills"
        />
      </InputGroup>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Built-in</h2>
          </CardTitle>
          <CardDescription>
            Read-only skills that ship with Codenaya. Duplicate one to change
            it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {builtins.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No built-in skills match &ldquo;{search.trim()}&rdquo;.
            </p>
          ) : (
            <ItemGroup aria-label="Built-in skills" className="gap-2">
              {builtins.map((skill) => {
                const attribution = BUILTIN_SKILL_ATTRIBUTIONS[skill.name];
                return (
                  <SkillCard
                    key={skill.name}
                    name={skill.name}
                    description={skill.description}
                    source="builtin"
                    meta={
                      attribution && (
                        <>
                          Adapted from{" "}
                          <a
                            href={attribution.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {attribution.label}
                          </a>{" "}
                          · {attribution.license} license
                        </>
                      )
                    }
                    actions={
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`View ${skill.name}`}
                          onClick={() =>
                            setEditorTarget({ kind: "builtin", name: skill.name })
                          }
                        >
                          <EyeIcon aria-hidden="true" />
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Duplicate ${skill.name}`}
                          onClick={() =>
                            setEditorTarget({
                              kind: "create",
                              scope: "library",
                              initial: { ...skill, name: `${skill.name}-copy` },
                            })
                          }
                        >
                          <CopyIcon aria-hidden="true" />
                          Duplicate
                        </Button>
                      </>
                    }
                  />
                );
              })}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>My library</h2>
          </CardTitle>
          <CardDescription>
            Skills you can enable in any of your projects.
          </CardDescription>
          {library && library.length > 0 && (
            <CardAction className="flex gap-2">
              {/* Placeholder for importing from GitHub / skills.sh (#104). */}
              <Button
                size="sm"
                variant="outline"
                disabled
                title="Import from GitHub is coming soon"
              >
                <DownloadIcon aria-hidden="true" />
                Import
              </Button>
              <Button size="sm" onClick={openCreate}>
                <PlusIcon aria-hidden="true" />
                New skill
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>{renderLibrary()}</CardContent>
      </Card>

      <SkillEditorDialog target={editorTarget} onTargetChange={setEditorTarget} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from your library and from every project it is
              enabled in. This cannot be undone.
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
    </>
  );
};

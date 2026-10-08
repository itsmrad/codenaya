"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { BUILTIN_SKILLS } from "../builtin";
import {
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  type SkillFields,
  validateSkill,
  validateSkillName,
} from "../limits";
import {
  skillErrorMessage,
  useCreateSkill,
  useSkill,
  useUpdateSkill,
} from "../hooks/use-skills";
import { SkillMarkdown } from "./skill-markdown";

import { Id } from "../../../../convex/_generated/dataModel";

type CreateScope = "project" | "library";

/** What the editor shows: a new skill, a stored one, or a read-only built-in. */
export type SkillEditorTarget =
  | { kind: "create"; initial?: SkillFields; scope?: CreateScope }
  | { kind: "edit"; skillId: Id<"skills"> }
  | { kind: "builtin"; name: string };

interface SkillEditorDialogProps {
  /** `null` closes the dialog. */
  target: SkillEditorTarget | null;
  onTargetChange: (target: SkillEditorTarget | null) => void;
  /** When set, new skills can be scoped to this project. */
  projectId?: Id<"projects">;
}

const EMPTY_SKILL: SkillFields = { name: "", description: "", body: "" };

const formatCount = (count: number, max: number) =>
  `${count.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;

/**
 * Creates, edits or views a skill as SKILL.md fields: a spec-valid name, a
 * description of what it does and when to use it, and a markdown body.
 */
export const SkillEditorDialog = ({
  target,
  onTargetChange,
  projectId,
}: SkillEditorDialogProps) => {
  const stored = useSkill(target?.kind === "edit" ? target.skillId : undefined);

  const renderForm = () => {
    if (!target) return null;

    if (target.kind === "builtin") {
      const builtin = BUILTIN_SKILLS.find((skill) => skill.name === target.name);
      if (!builtin) return null;
      return (
        <SkillEditorForm
          key={`builtin:${builtin.name}`}
          initial={builtin}
          readOnly
          onDuplicate={() =>
            onTargetChange({
              kind: "create",
              scope: "library",
              initial: { ...builtin, name: `${builtin.name}-copy` },
            })
          }
          onDone={() => onTargetChange(null)}
        />
      );
    }

    if (target.kind === "edit") {
      if (stored === undefined) {
        return (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading skill...
          </div>
        );
      }
      return (
        <SkillEditorForm
          key={stored._id}
          skillId={stored._id}
          initial={stored}
          onDone={() => onTargetChange(null)}
        />
      );
    }

    return (
      <SkillEditorForm
        key={`create:${target.initial?.name ?? ""}`}
        initial={target.initial ?? EMPTY_SKILL}
        projectId={projectId}
        initialScope={target.scope ?? (projectId ? "project" : "library")}
        onDone={() => onTargetChange(null)}
      />
    );
  };

  const title =
    target?.kind === "create"
      ? "New skill"
      : target?.kind === "edit"
        ? "Edit skill"
        : "Built-in skill";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && onTargetChange(null)}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target?.kind === "builtin"
              ? "Built-in skills are read-only. Duplicate one to your library to change it."
              : "The agent sees every enabled skill's name and description, and reads the instructions when a task matches."}
          </DialogDescription>
        </DialogHeader>
        {renderForm()}
      </DialogContent>
    </Dialog>
  );
};

interface SkillEditorFormProps {
  initial: SkillFields;
  /** Set when editing a stored skill. */
  skillId?: Id<"skills">;
  /** Set when creating from a project, to offer the project scope. */
  projectId?: Id<"projects">;
  initialScope?: CreateScope;
  readOnly?: boolean;
  onDuplicate?: () => void;
  onDone: () => void;
}

const SkillEditorForm = ({
  initial,
  skillId,
  projectId,
  initialScope = "library",
  readOnly = false,
  onDuplicate,
  onDone,
}: SkillEditorFormProps) => {
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [scope, setScope] = useState<CreateScope>(initialScope);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const isCreate = !skillId && !readOnly;
  const nameError = name ? validateSkillName(name) : null;
  const descriptionTooLong = description.length > SKILL_DESCRIPTION_MAX_LENGTH;
  const bodyTooLong = body.length > SKILL_BODY_MAX_LENGTH;
  const formError = validateSkill({ name, description, body });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (formError) return;

    setIsSaving(true);
    try {
      if (skillId) {
        await updateSkill({ skillId, name, description, body });
        toast.success(`Saved ${name}`);
      } else {
        await createSkill({
          name,
          description,
          body,
          projectId: scope === "project" ? projectId : undefined,
        });
        toast.success(`Created ${name}`);
      }
      onDone();
    } catch (error) {
      setServerError(skillErrorMessage(error, "Unable to save the skill"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
      <Field data-invalid={Boolean(nameError) || (submitted && !name)}>
        <FieldLabel htmlFor="skill-name">Name</FieldLabel>
        <Input
          id="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={readOnly}
          aria-invalid={Boolean(nameError) || (submitted && !name)}
          placeholder="seo-metadata"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        {nameError || (submitted && !name) ? (
          <FieldError>{nameError ?? validateSkillName(name)}</FieldError>
        ) : (
          !readOnly && (
            <FieldDescription>
              Lowercase letters, digits and single hyphens.
            </FieldDescription>
          )
        )}
      </Field>

      <Field
        data-invalid={descriptionTooLong || (submitted && !description.trim())}
      >
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor="skill-description">Description</FieldLabel>
          {!readOnly && (
            <span
              className={
                descriptionTooLong
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground tabular-nums"
              }
            >
              {formatCount(description.length, SKILL_DESCRIPTION_MAX_LENGTH)}
            </span>
          )}
        </div>
        <Textarea
          id="skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          readOnly={readOnly}
          aria-invalid={descriptionTooLong || (submitted && !description.trim())}
          placeholder="What the skill does and when the agent should use it."
          className="max-h-40 min-h-16"
        />
        {(descriptionTooLong || (submitted && !description.trim())) && (
          <FieldError>
            Description must be 1-{SKILL_DESCRIPTION_MAX_LENGTH} characters
          </FieldError>
        )}
      </Field>

      <Field data-invalid={bodyTooLong}>
        <Tabs defaultValue={readOnly ? "preview" : "write"} className="gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor="skill-body">Instructions</FieldLabel>
            <TabsList className="h-8">
              <TabsTrigger value="write" className="text-xs">
                {readOnly ? "Source" : "Write"}
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs">
                Preview
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="write">
            <Textarea
              id="skill-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              readOnly={readOnly}
              aria-invalid={bodyTooLong}
              placeholder={"# My skill\n\nRules, a short file skeleton, then pitfalls."}
              className="h-64 resize-y font-mono text-xs md:text-xs [field-sizing:fixed]"
            />
          </TabsContent>
          <TabsContent value="preview">
            <div className="h-64 overflow-y-auto rounded-md border bg-muted/20 px-3 py-2">
              {body.trim() ? (
                <SkillMarkdown>{body}</SkillMarkdown>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing to preview.</p>
              )}
            </div>
          </TabsContent>
        </Tabs>
        {!readOnly && (
          <FieldDescription
            className={bodyTooLong ? "text-destructive" : "tabular-nums"}
          >
            {formatCount(body.length, SKILL_BODY_MAX_LENGTH)} characters
          </FieldDescription>
        )}
      </Field>

      {isCreate && projectId && (
        <FieldSet>
          <FieldLegend variant="label">Save to</FieldLegend>
          <RadioGroup
            value={scope}
            onValueChange={(value) => setScope(value as CreateScope)}
            className="grid gap-2 sm:grid-cols-2"
          >
            {(
              [
                ["project", "This project only"],
                ["library", "My library"],
              ] as const
            ).map(([value, label]) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem value={value} id={`skill-scope-${value}`} />
                <FieldLabel htmlFor={`skill-scope-${value}`} className="font-normal">
                  {label}
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
      )}

      {serverError && <FieldError>{serverError}</FieldError>}

      <DialogFooter>
        {readOnly ? (
          <>
            <Button type="button" variant="outline" onClick={onDone}>
              Close
            </Button>
            <Button type="button" onClick={onDuplicate}>
              <CopyIcon aria-hidden="true" />
              Duplicate to my library
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving && <Spinner />}
              {skillId ? "Save changes" : "Create skill"}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
};

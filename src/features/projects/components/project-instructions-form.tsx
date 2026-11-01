"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { convexErrorMessage } from "@/lib/convex-error";

import { useProject, useUpdateProjectInstructions } from "../hooks/use-projects";
import { MAX_PROJECT_INSTRUCTIONS_LENGTH } from "../instructions";
import { Id } from "../../../../convex/_generated/dataModel";

const formatCount = (count: number) =>
  `${count.toLocaleString("en-US")} / ${MAX_PROJECT_INSTRUCTIONS_LENGTH.toLocaleString("en-US")}`;

/** Always-on instructions the agent gets on every run in this project (#299). */
export const ProjectInstructionsForm = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) => {
  const project = useProject(projectId);
  if (project === undefined) return null;
  return (
    <InstructionsEditor
      projectId={projectId}
      saved={project.instructions ?? ""}
    />
  );
};

const InstructionsEditor = ({
  projectId,
  saved,
}: {
  projectId: Id<"projects">;
  saved: string;
}) => {
  const updateInstructions = useUpdateProjectInstructions();
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  const tooLong = draft.length > MAX_PROJECT_INSTRUCTIONS_LENGTH;
  const changed = draft.trim() !== saved;

  const save = async () => {
    setSaving(true);
    try {
      await updateInstructions({ id: projectId, instructions: draft });
      toast.success("Instructions saved");
    } catch (error) {
      toast.error(convexErrorMessage(error, "Unable to save instructions"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Field data-invalid={tooLong}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor="project-instructions">Instructions</FieldLabel>
        <span
          className={
            tooLong
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground tabular-nums"
          }
        >
          {formatCount(draft.length)}
        </span>
      </div>
      <Textarea
        id="project-instructions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-invalid={tooLong}
        placeholder={"e.g. Keep the green brand colour.\nAll prices in INR.\nNever change the header."}
        className="max-h-60 min-h-24 text-xs md:text-xs"
      />
      <div className="flex items-start justify-between gap-3">
        <FieldDescription className={tooLong ? "text-destructive" : undefined}>
          {tooLong
            ? `Keep it under ${MAX_PROJECT_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`
            : "The agent follows these on every run in this project."}
        </FieldDescription>
        <Button
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={!changed || tooLong || saving}
          onClick={save}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </Field>
  );
};

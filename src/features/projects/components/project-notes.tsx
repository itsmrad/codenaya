"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { detectCredential } from "@/features/integrations/credential-guard";
import { convexErrorMessage } from "@/lib/convex-error";

import {
  useAddProjectNote,
  useProjectNotes,
  useRemoveProjectNote,
  useUpdateProjectNote,
} from "../hooks/use-project-notes";
import {
  MAX_PROJECT_NOTE_LENGTH,
  MAX_PROMPT_NOTES,
  NOTE_CREDENTIAL_ERROR,
  type ProjectNote,
} from "../notes";
import { Id } from "../../../../convex/_generated/dataModel";

const iconButtonClassName = "size-7 text-muted-foreground hover:text-foreground";

/** A note to save or edit; `noteId` set when editing one. */
export type NoteDraft = { text: string; noteId?: string };

/** Edits a note's text before saving it (#630). Closed when `draft` is null. */
export const ProjectNoteDialog = ({
  projectId,
  draft,
  onDraftChange,
}: {
  projectId: Id<"projects">;
  draft: NoteDraft | null;
  onDraftChange: (draft: NoteDraft | null) => void;
}) => {
  const addNote = useAddProjectNote();
  const updateNote = useUpdateProjectNote();
  const [saving, setSaving] = useState(false);
  const length = draft?.text.trim().length ?? 0;
  const tooLong = length > MAX_PROJECT_NOTE_LENGTH;

  const save = async () => {
    if (!draft) return;
    if (detectCredential(draft.text).detected) {
      toast.error(NOTE_CREDENTIAL_ERROR);
      return;
    }
    setSaving(true);
    try {
      if (draft.noteId) {
        await updateNote({ projectId, noteId: draft.noteId, text: draft.text });
      } else {
        await addNote({ projectId, text: draft.text });
      }
      toast.success("Saved to this project's notes");
      onDraftChange(null);
    } catch (error) {
      toast.error(convexErrorMessage(error, "Unable to save the note"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onDraftChange(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{draft?.noteId ? "Edit note" : "Remember for this project"}</DialogTitle>
          <DialogDescription>
            The agent reads this project&apos;s notes on every run here, and nowhere else.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Note"
          value={draft?.text ?? ""}
          onChange={(e) => draft && onDraftChange({ ...draft, text: e.target.value })}
          aria-invalid={tooLong}
          className="min-h-20 text-xs md:text-xs"
        />
        <p className={tooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {length} / {MAX_PROJECT_NOTE_LENGTH}
        </p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onDraftChange(null)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!length || tooLong || saving} onClick={save}>
            {saving ? "Saving..." : "Save note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The project's saved notes, each editable and deletable (#630). */
export const ProjectNotesList = ({ projectId }: { projectId: Id<"projects"> }) => {
  const notes = useProjectNotes(projectId);
  const removeNote = useRemoveProjectNote();
  const [draft, setDraft] = useState<NoteDraft | null>(null);

  if (notes === undefined) return null;

  const remove = async (note: ProjectNote) => {
    try {
      await removeNote({ projectId, noteId: note.id });
    } catch (error) {
      toast.error(convexErrorMessage(error, "Unable to delete the note"));
    }
  };

  const renderNotes = () => {
    if (notes === null) {
      return <p className="text-xs text-muted-foreground">Notes are unavailable right now.</p>;
    }
    if (notes.length === 0) {
      return (
        <p className="text-xs text-muted-foreground">
          No notes yet. Use &quot;Remember for this project&quot; on a chat message to add one.
        </p>
      );
    }
    return (
      <>
        <ul className="divide-y divide-border/50 rounded-md border border-border/50">
          {notes.map((note) => (
            <li key={note.id} className="flex items-start gap-2 px-3 py-2">
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">
                {note.text}
              </p>
              <Button
                size="icon"
                variant="ghost"
                className={iconButtonClassName}
                aria-label="Edit note"
                title="Edit"
                onClick={() => setDraft({ text: note.text, noteId: note.id })}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className={`${iconButtonClassName} hover:text-destructive`}
                aria-label="Delete note"
                title="Delete"
                onClick={() => void remove(note)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        {notes.length > MAX_PROMPT_NOTES && (
          <p className="text-xs text-muted-foreground">
            Runs read the newest {MAX_PROMPT_NOTES} notes.
          </p>
        )}
      </>
    );
  };

  return (
    <section aria-labelledby="project-notes-heading" className="space-y-2">
      <h3 id="project-notes-heading" className="text-xs font-medium text-muted-foreground">
        Notes
      </h3>
      {renderNotes()}
      <ProjectNoteDialog projectId={projectId} draft={draft} onDraftChange={setDraft} />
    </section>
  );
};

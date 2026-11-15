import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { getOwnedProject } from "./projects";
import { detectCredential } from "../src/features/integrations/credential-guard";
import {
  MAX_PROJECT_NOTE_LENGTH,
  MAX_PROJECT_NOTES,
  NOTE_CREDENTIAL_ERROR,
  type ProjectNote,
} from "../src/features/projects/notes";

const noteValidator = v.object({ id: v.string(), text: v.string(), createdAt: v.number() });

function validNoteText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw appError("INVALID_ARGUMENT", "A note can't be empty");
  if (trimmed.length > MAX_PROJECT_NOTE_LENGTH) {
    throw appError(
      "INVALID_ARGUMENT",
      `A note must be at most ${MAX_PROJECT_NOTE_LENGTH} characters`,
    );
  }
  if (detectCredential(trimmed).detected) {
    throw appError("INVALID_ARGUMENT", NOTE_CREDENTIAL_ERROR);
  }
  return trimmed;
}

/** Applies `change` to the caller's project notes and saves them. */
async function editNotes(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  change: (notes: ProjectNote[]) => ProjectNote[],
) {
  const identity = await verifyAuth(ctx);
  const project = await getOwnedProject(ctx, projectId, identity.subject);
  const notes = change(project.notes ?? []);
  await ctx.db.patch("projects", projectId, {
    notes: notes.length ? notes : undefined,
    updatedAt: Date.now(),
  });
}

/** The project's notes, oldest first (#630). Owner only. */
export const list = query({
  args: { projectId: v.id("projects") },
  returns: v.array(noteValidator),
  handler: async (ctx, args) => {
    const identity = await verifyAuth(ctx);
    const project = await getOwnedProject(ctx, args.projectId, identity.subject);
    return project.notes ?? [];
  },
});

export const add = mutation({
  args: { projectId: v.id("projects"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const text = validNoteText(args.text);
    await editNotes(ctx, args.projectId, (notes) => {
      if (notes.length >= MAX_PROJECT_NOTES) {
        throw appError(
          "LIMIT_EXCEEDED",
          `A project can keep at most ${MAX_PROJECT_NOTES} notes. Delete one first.`,
        );
      }
      return [...notes, { id: crypto.randomUUID(), text, createdAt: Date.now() }];
    });
    return null;
  },
});

export const update = mutation({
  args: { projectId: v.id("projects"), noteId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const text = validNoteText(args.text);
    await editNotes(ctx, args.projectId, (notes) => {
      if (!notes.some((note) => note.id === args.noteId)) {
        throw appError("NOT_FOUND", "Note not found");
      }
      return notes.map((note) => (note.id === args.noteId ? { ...note, text } : note));
    });
    return null;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), noteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await editNotes(ctx, args.projectId, (notes) =>
      notes.filter((note) => note.id !== args.noteId),
    );
    return null;
  },
});

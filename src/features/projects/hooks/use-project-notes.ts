"use client";

import { useMemo } from "react";
import { useMutation, useQueries } from "convex/react";

import type { ProjectNote } from "../notes";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * The project's notes (#630): `undefined` while loading, `null` when the
 * backend can't serve them (an older deploy without `projectNotes`).
 * `useQueries` hands that failure back as an Error instead of throwing it.
 * The request object must be memoized: a new identity every render makes
 * `useQueries` set state during render and loop ("Too many re-renders").
 */
export const useProjectNotes = (projectId: Id<"projects">): ProjectNote[] | null | undefined => {
  const queries = useMemo(
    () => ({ notes: { query: api.projectNotes.list, args: { projectId } } }),
    [projectId],
  );
  const notes = useQueries(queries).notes as ProjectNote[] | Error | undefined;
  return notes instanceof Error ? null : notes;
};

export const useAddProjectNote = () => useMutation(api.projectNotes.add);
export const useUpdateProjectNote = () => useMutation(api.projectNotes.update);
export const useRemoveProjectNote = () => useMutation(api.projectNotes.remove);

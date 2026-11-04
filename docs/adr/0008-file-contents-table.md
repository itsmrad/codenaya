# 0008. A text file's content lives in `fileContents`, not on the `files` doc

- Status: Accepted
- Date: 2026-10-25
- Related: #412, #411

## Context

Convex bills the bytes of every document a query reads. `files` docs carried
the file's text, so every query that lists a project (`files.getFiles`,
`getFolderContents`, `system.getProjectFiles`) read every file's full text,
even though its callers only need names and parent ids. `getFiles` stays
subscribed in the project view and the chat sidebar, and every content write
(autosave, agent edits, checkpoint restore) patched a `files` doc, so each one
re-read the whole project in every open tab. On dev, `getFiles` was ~95% of
all database reads (2.2 GB in one cycle), well over the Free limit.

## Decision

- Text goes in `fileContents { fileId, projectId, content }` (indexes
  `by_file`, `by_project`), one row per text file. `files` keeps metadata and
  `storageId` for binary files.
- `convex/fileContents.ts` owns the table and is the only code that reads or
  writes it: `readFileContent` (one file), `withContents` (a project's files,
  one index range), `writeFileContent` (upsert, or delete when undefined),
  `insertFileContent` (a just-created file), `withoutContent` (list results).
- List queries return metadata only. Callers that need text read it through a
  query that already checks ownership: `files.getFile`, `files.getFilesWithUrls`
  (ZIP, preview), `system.getFileById`, `system.getProjectFilesWithUrls`
  (GitHub export, check-build). No new public or internal-key function.
- A content write never patches the `files` doc, so file lists don't re-run on
  edits. `files.updatedAt` therefore tracks metadata changes only (nothing
  reads it).
- Every path that deletes a file deletes its content row first (file and
  folder delete, import cleanup, project cascade, checkpoint restore).
- Migration is widen → migrate → narrow. This change widens (`files.content`
  stays optional and every read falls back to it) and ships
  `internal.fileContents.backfill`, an idempotent, byte-capped, self-rescheduling
  mutation. A follow-up drops `files.content`, the fallbacks and the backfill
  once the backfill logs `moved 0` on every deployment; `convex deploy` then
  refuses the schema if any doc still holds text.

## Alternatives considered

- **Return only metadata from the list queries.** Saves nothing: Convex bills
  bytes read, not bytes returned.
- **Text in file storage blobs.** A fetch per file for the editor, agent tools
  and preview, and no transactional write with the metadata.
- **Dual-write `files.content` until the narrow step.** Keeps a code revert
  safe, but delays the whole bandwidth win to the narrow step. We fix forward
  instead and take a prod export before the backfill.

## Consequences

- Listing a project reads ~200 B per file instead of the whole file; an
  autosave reads under 1 KB and no longer re-runs any list.
- Reading a project's text costs one extra index range, and the preview reads
  the whole project's text through `getFilesWithUrls` on each edit while open.
- After this deploys, reverting the code would show stale text for files edited
  since; recovery is a reverse copy or the pre-backfill export.
- Revisit if the preview's full read shows up in usage (per-file sync then).

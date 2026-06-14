# FileExplorer

A collapsible, nested sidebar panel for browsing, creating, renaming, and deleting files and folders within a Codenaya project. Folder contents are loaded lazily — a folder's children are only fetched from Convex when the user expands it. Clicking a file opens it as a preview tab in the editor; double-clicking pins it as a permanent tab.

## When to use

Render `<FileExplorer>` once inside the IDE layout's left sidebar whenever a project is open. It owns all file-system interactions for that project and communicates with the editor through the shared `useEditor` context.

## Props

### `<FileExplorer>`

| Prop        | Type               | Required | Description                                      |
|-------------|-------------------|----------|--------------------------------------------------|
| `projectId` | `Id<"projects">`   | yes      | Convex document ID for the project to display.   |

### Internal sub-components (not imported directly)

`Tree` — one node in the tree; rendered recursively. Props: `item: Doc<"files">`, `level: number` (default `0`), `projectId`.

`TreeItemWrapper` — the clickable row and right-click context menu. Exposes optional callback overrides: `onClick`, `onDoubleClick`, `onRename`, `onDelete`, `onCreateFile`, `onCreateFolder`.

`CreateInput` — inline input shown when creating a new item. Props: `type: "file" | "folder"`, `level`, `onSubmit(name)`, `onCancel`.

`RenameInput` — inline input shown when renaming. On focus it auto-selects the filename stem (everything before the last `.`) for files, or the full name for folders.

## Hooks (`use-files.ts`)

The component tree uses these hooks internally; you can also import them elsewhere in the project.

`useFolderContents({ projectId, parentId?, enabled? })` — real-time query for the children of a folder. Pass `parentId` omitted for root. Use `enabled: false` to skip fetching until the folder is expanded.

`useCreateFile()` / `useCreateFolder()` — Convex mutations with optimistic updates. New items appear immediately and are sorted (folders first, then alphabetical).

`useRenameFile({ projectId, parentId })` — mutation that patches the item name and re-sorts the local cache.

`useDeleteFile({ projectId, parentId })` — mutation that removes the item from the cache and closes any open editor tab for it.

`useFiles(projectId)` / `useFile(fileId)` — flat file-list and single-file reads for use outside the explorer (breadcrumbs, editor, etc.).

`useFilePath(fileId)` — resolves the full path segment array for a file; useful for breadcrumb displays.

`useUpdateFile()` — bare mutation (no optimistic update) for saving file content from the editor.

## Example usage

```tsx
import { FileExplorer } from "@/features/projects/components/file-explorer";
import { Id } from "@/convex/_generated/dataModel";

export function IDESidebar({ projectId }: { projectId: Id<"projects"> }) {
  return (
    <aside className="w-64 border-r overflow-y-auto">
      <FileExplorer projectId={projectId} />
    </aside>
  );
}
```

## Indentation constants

`constants.ts` exports `BASE_PADDING = 12`, `LEVEL_PADDING = 12`, and a helper `getItemPadding(level, isFile)` that adds an extra 16 px for files (since they skip the chevron). Import these if you need to match the tree's indentation in a custom row component.

## Known limitations

- **No drag-and-drop reordering.** Files and folders are always sorted: folders first, then alphabetical within each group.
- **No multi-select.** Only one item at a time can be created, renamed, or deleted.
- **WebContainer not wired here.** The explorer manages Convex-backed metadata only; syncing to the in-browser WebContainer file system is handled separately (Chapter 14).
- **Context menu is right-click only.** There is no touch / long-press equivalent, so the create/rename/delete actions are inaccessible on touch-only devices.

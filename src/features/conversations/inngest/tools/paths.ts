import type { FunctionReturnType } from "convex/server";

import { buildPathIndex, lockedPathMessage, normalizePath } from "@/features/conversations/agent-steps";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { getFileByAgentId } from "./get-file";

/**
 * Path addressing for the agent's file tools (#292): the model names files by
 * project-relative `/`-separated paths, never by document id.
 */

export { normalizePath };

export type ProjectFile = FunctionReturnType<typeof api.system.getProjectFiles>[number];

/** Entries in the system prompt's file list before the rest become "+N more". */
export const MAX_PROMPT_TREE_ENTRIES = 300;

export const getProjectFiles = (internalKey: string, projectId: Id<"projects">) =>
  convex.query(api.system.getProjectFiles, { internalKey, projectId });

export const invalidPathError = (raw: string) =>
  `Error: Invalid path "${raw}". Use a project-relative path like "src/App.tsx": no leading "/", and no "..", "." or empty segments.`;

export const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
};

/** The project's files by path and by id. A file and a folder may share a path (#267). */
export const indexProjectFiles = (files: ProjectFile[]) => {
  const pathOf = buildPathIndex(files);
  const byId = new Map(files.map((file) => [file._id as string, file]));
  const byPath = new Map<string, Partial<Record<ProjectFile["type"], ProjectFile>>>();
  for (const file of files) {
    const path = pathOf(file._id);
    if (path) byPath.set(path, { ...byPath.get(path), [file.type]: file });
  }
  return { pathOf, byId, byPath };
};

export type ProjectIndex = ReturnType<typeof indexProjectFiles>;

/**
 * The file or folder a tool call names by `path`, or by `fileId` in calls made
 * before #292. A path names the file when a file and a folder share it, unless
 * it ends in "/". An id is looked up directly (project-scoped), so a file past
 * the `getProjectFiles` cap still resolves; the index only names it.
 */
export const findProjectFile = async (
  internalKey: string,
  projectId: Id<"projects">,
  index: ProjectIndex,
  ref: { path?: string; fileId?: string },
): Promise<{ file: ProjectFile; path: string } | { error: string }> => {
  if (typeof ref.path === "string") {
    const path = normalizePath(ref.path);
    if (path === undefined) return { error: invalidPathError(ref.path) };
    const entry = index.byPath.get(path);
    const file = ref.path.trim().endsWith("/") ? entry?.folder : (entry?.file ?? entry?.folder);
    return file
      ? { file, path }
      : { error: `Error: "${path}" not found. Use a path from the project's file list.` };
  }
  const file = ref.fileId ? await getFileByAgentId(internalKey, projectId, ref.fileId) : null;
  if (!file) {
    return {
      error: ref.fileId
        ? 'Error: File not found. Address files by path, like "src/App.tsx".'
        : 'Error: Provide a path, like "src/App.tsx".',
    };
  }
  return { file, path: index.pathOf(file._id) ?? file.name };
};

/**
 * The error for writing `path` when the user locked it or a folder above it,
 * or with `inside` (a rename or delete) anything under it (#307). Checked
 * before writing so a refusal is a plain tool result; the Convex write
 * mutations enforce the same rule.
 */
export const lockedPathError = (index: ProjectIndex, path: string, inside = false) => {
  for (const [lockedPath, entry] of index.byPath) {
    if (!entry.file?.locked && !entry.folder?.locked) continue;
    if (lockedPath === path || path.startsWith(`${lockedPath}/`)) return lockedPathMessage(path);
    if (inside && lockedPath.startsWith(`${path}/`)) return lockedPathMessage(lockedPath);
  }
  return undefined;
};

/**
 * Returns the id of the folder at `path`, creating it and any missing parents.
 * `folders` maps folder paths to ids and gains the folders it creates.
 */
export const folderEnsurer = (
  internalKey: string,
  projectId: Id<"projects">,
  folders: Map<string, Id<"files">>,
) => {
  const ensureFolder = async (path: string): Promise<Id<"files"> | undefined> => {
    if (!path) return undefined;
    const known = folders.get(path);
    if (known) return known;
    const { dir, name } = splitPath(path);
    const folderId = await convex.mutation(api.system.createFolder, {
      internalKey,
      projectId,
      name,
      parentId: await ensureFolder(dir),
    });
    folders.set(path, folderId);
    return folderId;
  };
  return ensureFolder;
};

/** Every folder's path and id. */
export const folderPaths = (index: ProjectIndex) =>
  new Map(
    [...index.byPath].flatMap(([path, entry]) =>
      entry.folder ? [[path, entry.folder._id] as const] : [],
    ),
  );

/** Every path in the project, sorted by code point; folders end in "/". */
export const listProjectPaths = (files: ProjectFile[]) => {
  const pathOf = buildPathIndex(files);
  return files
    .flatMap((file) => {
      const path = pathOf(file._id);
      return path ? [file.type === "folder" ? `${path}/` : path] : [];
    })
    .sort();
};

// #307: named up front so the model plans around locked paths.
const lockedLine = (files: ProjectFile[]) => {
  const pathOf = buildPathIndex(files);
  const locked = files.flatMap((file) => (file.locked && pathOf(file._id)) || []).sort();
  return locked.length > 0
    ? [`Locked by the user, so writes to these and anything inside them are refused: ${locked.join(", ")}`]
    : [];
};

/**
 * The system prompt's list of project files. Deterministic for the same files,
 * whatever order they come in. Past the cap, shallow paths win so the top-level
 * layout always shows.
 */
export const buildProjectTreePromptSection = (files: ProjectFile[]) => {
  const paths = listProjectPaths(files);
  if (paths.length === 0) {
    return "\n\n## Project files\nThe project is empty.";
  }
  const depth = (path: string) => path.replace(/\/$/, "").split("/").length;
  const shown =
    paths.length <= MAX_PROMPT_TREE_ENTRIES
      ? paths
      : [...paths]
          .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))
          .slice(0, MAX_PROMPT_TREE_ENTRIES)
          .sort();
  const hidden = paths.length - shown.length;
  return [
    "\n\n## Project files",
    'Every file and folder at the start of this run (folders end in "/"). Address files by these paths.',
    ...shown,
    ...(hidden > 0 ? [`+${hidden} more (call listFiles to see them)`] : []),
    ...lockedLine(files),
  ].join("\n");
};

import { buildPathIndex } from "@/features/conversations/agent-steps";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";

/** A project file or folder, keyed by its path (#292). */
export interface TreeEntry {
  _id: Id<"files">;
  type: "file" | "folder";
}

/**
 * Validates a project-relative, `/`-separated path from the agent. A leading
 * `./` is dropped; absolute paths, backslashes and empty, `.` or `..` segments
 * are refused with a message the model can act on.
 */
export const parseAgentPath = (raw: string): { path: string } | { error: string } => {
  const path = raw.trim().replace(/^\.\//, "");
  if (!path) return { error: "Path is empty" };
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return { error: `"${raw}" must be a project-relative path with "/" separators, like src/App.tsx` };
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { error: `"${raw}" has an empty, "." or ".." segment; use a plain path like src/components/Button.tsx` };
  }
  return { path };
};

export const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
};

/** Every folder above `path`, outermost first: `a/b/c.ts` gives `a`, `a/b`. */
export const ancestorsOf = (path: string) =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, index, segments) => segments.slice(0, index + 1).join("/"));

/** The project's files and folders by path, read in one query. */
export const loadProjectTree = async (internalKey: string, projectId: Id<"projects">) => {
  const files = await convex.query(api.system.getProjectFiles, { internalKey, projectId });
  const pathOf = buildPathIndex(files);
  const byPath = new Map<string, TreeEntry>(
    files.map((file) => [pathOf(file._id) ?? file.name, { _id: file._id, type: file.type }]),
  );
  return { pathOf, byPath };
};

/**
 * Creates each missing folder on a path, reusing the ones in `byPath` and
 * adding the new ones to it. Callers check first that no part is a file.
 */
export const createFolderEnsurer = (
  internalKey: string,
  projectId: Id<"projects">,
  byPath: Map<string, TreeEntry>,
) => {
  const ensureFolder = async (path: string): Promise<Id<"files"> | undefined> => {
    if (!path) return undefined;
    const known = byPath.get(path);
    if (known) return known._id;
    const { dir, name } = splitPath(path);
    const folderId = await convex.mutation(api.system.createFolder, {
      internalKey,
      projectId,
      name,
      parentId: await ensureFolder(dir),
    });
    byPath.set(path, { _id: folderId, type: "folder" });
    return folderId;
  };
  return ensureFolder;
};

/**
 * Resolves a tool's `path` (or legacy `fileId`) argument to a file id. Call it
 * inside `step.run`: on replay a path read outside the step would already see
 * a rename or delete the step made.
 */
export const resolveFileRef = async (
  internalKey: string,
  projectId: Id<"projects">,
  ref: { path?: string; fileId?: string },
): Promise<{ fileId: string } | { error: string }> => {
  if (ref.path === undefined) {
    return ref.fileId ? { fileId: ref.fileId } : { error: "Provide a path, like src/App.tsx" };
  }
  const parsed = parseAgentPath(ref.path);
  if ("error" in parsed) return parsed;
  const entry = (await loadProjectTree(internalKey, projectId)).byPath.get(parsed.path);
  return entry
    ? { fileId: entry._id }
    : { error: `Nothing at "${parsed.path}". Use listFiles to see the project's paths` };
};

import { type AgentStep, buildPathIndex, runWrittenPaths } from "@/features/conversations/agent-steps";

export const MAX_RECENTLY_CHANGED = 5;

/**
 * The files the last run wrote that still exist, most recently written first (#315).
 * Steps are read newest first, so a path written twice ranks by its last write; within one
 * step the paths keep the order the call listed them in.
 * A path that no longer resolves to a file (deleted, renamed away, a folder) is dropped.
 */
export const recentlyChangedFiles = <
  F extends { _id: string; name: string; type: "file" | "folder"; parentId?: string },
>(
  steps: AgentStep[],
  files: F[],
  limit = MAX_RECENTLY_CHANGED,
): { file: F; path: string }[] => {
  const pathOf = buildPathIndex(files);
  const byPath = new Map(
    files.filter((file) => file.type === "file").flatMap((file) => {
      const path = pathOf(file._id);
      return path ? [[path, file] as const] : [];
    }),
  );
  return runWrittenPaths([...steps].reverse())
    .flatMap((path) => {
      const file = byPath.get(path);
      return file ? [{ file, path }] : [];
    })
    .slice(0, limit);
};

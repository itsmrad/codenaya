import { buildPathIndex, type PathIndexFile } from "../agent-steps";
import { VITE_REACT_STARTER } from "./vite-starter";
import { NEXT_APP_STARTER } from "./next-starter";

type ProjectFileRow = PathIndexFile & { type: "file" | "folder" };

/**
 * Which starter's exact file set the project holds, or null for an edited tree.
 */
export const starterFramework = (files: ProjectFileRow[]): "vite" | "next" | null => {
  const pathOf = buildPathIndex(files);
  const filePaths = new Set(
    files.filter((file) => file.type === "file").map((file) => pathOf(file._id)),
  );
  for (const [framework, starter] of [["vite", VITE_REACT_STARTER], ["next", NEXT_APP_STARTER]] as const) {
    if (filePaths.size === starter.length && starter.every(({ path }) => filePaths.has(path))) {
      return framework;
    }
  }
  return null;
};

export const isStarterOnly = (files: ProjectFileRow[]) => starterFramework(files) !== null;

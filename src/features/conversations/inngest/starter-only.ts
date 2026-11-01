import { buildPathIndex, type PathIndexFile } from "../agent-steps";
import { VITE_REACT_STARTER } from "./vite-starter";

type ProjectFileRow = PathIndexFile & { type: "file" | "folder" };

/**
 * Whether the project holds exactly the Vite starter's files, as seeded at
 * creation (#338), so the request can say the starter is already in place.
 */
export const isStarterOnly = (files: ProjectFileRow[]) => {
  const pathOf = buildPathIndex(files);
  const filePaths = new Set(
    files.filter((file) => file.type === "file").map((file) => pathOf(file._id)),
  );
  return (
    filePaths.size === VITE_REACT_STARTER.length &&
    VITE_REACT_STARTER.every(({ path }) => filePaths.has(path))
  );
};

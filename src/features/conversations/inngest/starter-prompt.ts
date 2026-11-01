import { buildPathIndex, type PathIndexFile } from "../agent-steps";
import { VITE_REACT_STARTER } from "./vite-starter";

type ProjectFileRow = PathIndexFile & { type: "file" | "folder" };

/**
 * The prompt section for a project that holds only the Vite starter, as seeded
 * at creation (#338): its file and folder ids, so the first model turn writes
 * app code instead of spending turns on listFiles and scaffoldViteApp. Empty
 * for any other project.
 */
export const buildStarterPromptSection = (files: ProjectFileRow[]) => {
  const pathOf = buildPathIndex(files);
  const filePaths = new Set(
    files.filter((file) => file.type === "file").map((file) => pathOf(file._id)),
  );
  const isStarterOnly =
    filePaths.size === VITE_REACT_STARTER.length &&
    VITE_REACT_STARTER.every(({ path }) => filePaths.has(path));
  if (!isStarterOnly) return "";

  const rows = files
    .map((file) => `- ${pathOf(file._id)} (${file.type}, id: ${file._id})`)
    .sort();
  return `\n\n## Workspace
The project holds only the Vite starter that scaffoldViteApp writes, already in place. Do not call listFiles or scaffoldViteApp; build on these files (root-level files have no parentId):
${rows.join("\n")}`;
};

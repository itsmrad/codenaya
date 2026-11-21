import { buildPathIndex, type PathIndexFile } from "../src/features/conversations/agent-steps";
import { isSecretPath } from "./secretFiles";

/** Top-level generated output is rebuilt in the destination. Nested source folders keep their names. */
const RUNTIME_OUTPUTS = new Set([".next", ".nuxt", ".output", ".cache", ".turbo", ".vercel", ".netlify", "dist", "build", "coverage"]);

const normalizedSegment = (part: string) => {
  const name = part.trim().toLowerCase();
  let end = name.length;
  while (end > 0 && (name[end - 1] === "." || name[end - 1] === " ")) end--;
  return name.slice(0, end);
};

/** The shared transfer policy also protects local/remote private files during GitHub sync. */
export const isPrivatePath = (path: string, type: "file" | "folder" = "file") => {
  if (type === "file" && isSecretPath(path)) return true;
  const parts = path.split(/[\\/]/).filter(part => part && part !== ".");
  const directories = type === "folder" ? parts : parts.slice(0, -1);
  return directories.some(part => ["node_modules", ".git"].includes(normalizedSegment(part))) ||
    (directories.length > 0 && RUNTIME_OUTPUTS.has(normalizedSegment(directories[0])));
};

export const withoutPrivateFiles = <T extends { path: string; type?: "file" | "folder" }>(files: T[]) =>
  files.filter(({ path, type }) => !isPrivatePath(path, type));

/** Filter before content hydration or storage URL generation, retaining the original tree ids. */
export const transferableTree = <T extends PathIndexFile & { type: "file" | "folder" }>(files: T[]): T[] => {
  const pathOf = buildPathIndex(files);
  return withoutPrivateFiles(files.map(file => ({ file, type: file.type, path: pathOf(file._id) ?? file.name })))
    .map(({ file }) => file);
};

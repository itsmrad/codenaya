import { buildPathIndex, type PathIndexFile } from "../src/features/conversations/agent-steps";
import { isSecretPath, withoutSecretFiles } from "./secretFiles";

/** Generated runtime state is rebuilt in the destination, never transferred. */
const RUNTIME_DIRECTORIES = new Set(["node_modules", ".git", ".next", ".nuxt", ".output", ".cache", ".turbo", ".vercel", ".netlify", "dist", "build", "coverage"]);

const runtimeDirectory = (part: string) => {
  const name = part.trim().toLowerCase();
  let end = name.length;
  while (end > 0 && (name[end - 1] === "." || name[end - 1] === " ")) end--;
  return RUNTIME_DIRECTORIES.has(name.slice(0, end));
};

/** Secret names use the one shared policy, including folders and alternate separators. */
export const withoutPrivateFiles = <T extends { path: string }>(files: T[]) =>
  withoutSecretFiles(files).filter(({ path }) => !path.split(/[\\/]/).some(part =>
    isSecretPath(part) || runtimeDirectory(part)));

/** Filter before content hydration or storage URL generation, retaining the original tree ids. */
export const transferableTree = <T extends PathIndexFile>(files: T[]): T[] => {
  const pathOf = buildPathIndex(files);
  return withoutPrivateFiles(files.map(file => ({ file, path: pathOf(file._id) ?? file.name })))
    .map(({ file }) => file);
};

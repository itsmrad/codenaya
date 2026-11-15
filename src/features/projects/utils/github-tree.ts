import type { Doc, Id } from "../../../../convex/_generated/dataModel";

/** Maps each file's full path (`src/app/page.tsx`) to the file. */
export const buildFilePaths = <T extends Doc<"files">>(files: T[]) => {
  const fileMap = new Map<Id<"files">, T>();
  files.forEach((f) => fileMap.set(f._id, f));

  const getFullPath = (file: T): string => {
    if (!file.parentId) {
      return file.name;
    }

    const parent = fileMap.get(file.parentId);

    if (!parent) {
      return file.name;
    }

    return `${getFullPath(parent)}/${file.name}`;
  };

  const paths: Record<string, T> = {};
  files.forEach((file) => {
    paths[getFullPath(file)] = file;
  });

  return paths;
};

/** Splits `a/b/c.ts` into its name and parent path (`""` at the root). */
export const splitPath = (path: string) => {
  const pathParts = path.split("/");
  const name = pathParts.pop()!;
  return { name, parentPath: pathParts.join("/") };
};

/**
 * Folders in creation order: sorted by depth so parents are created before
 * children, whatever order the repo listed them in.
 * Input:  ["src/components", "src", "src/components/ui"]
 * Output: ["src", "src/components", "src/components/ui"]
 */
export const planFolderCreation = (folders: string[]) =>
  [...folders]
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .map((path) => ({ path, ...splitPath(path) }));

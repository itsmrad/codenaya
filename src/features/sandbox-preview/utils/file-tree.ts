import { Doc, Id } from "../../../../convex/_generated/dataModel";

type FileDoc = Doc<"files">;

/**
 * Get full path for a file by traversing parent chain
 */
export const getFilePath = (
  file: FileDoc,
  filesMap: Map<Id<"files">, FileDoc>
): string => {
  const parts: string[] = [file.name];
  let parentId = file.parentId;

  while (parentId) {
    const parent = filesMap.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }

  return parts.join("/");
};

/**
 * Convert flat Convex files to a flat list of { path, content } for E2B.
 * Only includes text files (skips folders and binary/storage files).
 */
export const buildFlatFileList = (
  files: FileDoc[]
): { path: string; content: string }[] => {
  const filesMap = new Map(files.map((f) => [f._id, f]));
  const result: { path: string; content: string }[] = [];

  for (const file of files) {
    // Skip folders and binary files
    if (file.type !== "file" || file.storageId || file.content === undefined) {
      continue;
    }

    const path = getFilePath(file, filesMap);
    result.push({ path, content: file.content });
  }

  return result;
};

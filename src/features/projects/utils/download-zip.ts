import JSZip from "jszip";

import { getFilePath } from "@/features/sandbox-preview/utils/file-tree";

import { Doc } from "../../../../convex/_generated/dataModel";

/** A project file as returned by `files.getFilesWithUrls`. */
export type ZipSourceFile = Doc<"files"> & { storageUrl: string | null };

const fetchBytes = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  return response.arrayBuffer();
};

/**
 * Builds a zip of the project's files, keeping the folder structure.
 * Text files are written from their content; binary files are fetched from
 * their storage URL. Empty folders are kept as directory entries.
 */
export const createProjectZip = async (
  files: ZipSourceFile[],
  fetchBinary: (url: string) => Promise<ArrayBuffer> = fetchBytes,
): Promise<JSZip> => {
  const zip = new JSZip();
  const filesMap = new Map(files.map((file) => [file._id, file]));

  await Promise.all(
    files.map(async (file) => {
      const path = getFilePath(file, filesMap);

      if (file.type === "folder") {
        zip.folder(path);
        return;
      }

      if (file.storageId) {
        if (!file.storageUrl) {
          throw new Error(`Missing stored content for ${path}`);
        }
        zip.file(path, await fetchBinary(file.storageUrl), { binary: true });
        return;
      }

      zip.file(path, file.content ?? "");
    }),
  );

  return zip;
};

/** `<project-name>.zip`, with characters that are invalid in file names replaced. */
export const getZipFileName = (projectName: string) =>
  `${projectName.trim().replace(/[\\/:*?"<>|]/g, "-") || "project"}.zip`;

/** Saves a blob through a temporary download link. */
export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
